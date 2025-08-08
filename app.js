const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// 引入自定義模塊
const Database = require('./database');
const EmailService = require('./emailService');

// 載入配置
let config;
try {
    config = require('./config');
} catch (err) {
    console.error('❌ 找不到 config.js 文件！');
    console.log('請建立 config.js 並填入您的配置');
    process.exit(1);
}

const app = express();

// 初始化數據庫和郵件服務
const database = new Database(config.database.filename);
const emailService = new EmailService(config.email);

// 安全中間件
app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https:"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
            fontSrc: ["'self'", "https:", "data:"],
        },
    },
}));

// 速率限制
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: {
        error: 'RATE_LIMIT_EXCEEDED',
        message: '請求過於頻繁，請稍後再試'
    }
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: {
        error: 'AUTH_RATE_LIMIT_EXCEEDED',
        message: '認證請求過於頻繁，請稍後再試'
    }
});

app.use(limiter);

// CORS 配置（允許動態來源）
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 中間件
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 本地開發時提供靜態檔案
app.use(express.static(path.join(__dirname, '/')));

// 創建上傳目錄
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// 文件上傳配置
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'avatar-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) return cb(null, true);
        cb(new Error('只允許圖片文件 (jpeg, jpg, png, gif, webp)'));
    }
});

// JWT 中間件
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'NO_TOKEN', message: '需要訪問令牌' });
    }
    jwt.verify(token, config.server.jwtSecret, (err, user) => {
        if (err) return res.status(403).json({ error: 'INVALID_TOKEN', message: '無效的訪問令牌' });
        req.user = user;
        next();
    });
};

// API 路由
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'FayCR連線室後端服務運行中', timestamp: new Date().toISOString() });
});

app.get('/api/test-email', async (req, res) => {
    try {
        const result = await emailService.testConnection();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: 'EMAIL_TEST_FAILED', message: error.message });
    }
});

app.post('/api/register', authLimiter, async (req, res) => {
    try {
        const { username, email, password, avatar } = req.body;
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'MISSING_FIELDS', message: '請填寫所有必填欄位' });
        }
        if (username.length < 2) return res.status(400).json({ error: 'INVALID_USERNAME', message: '使用者名稱至少需要2個字元' });
        if (password.length < 6) return res.status(400).json({ error: 'INVALID_PASSWORD', message: '密碼至少需要6個字元' });
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return res.status(400).json({ error: 'INVALID_EMAIL', message: '請輸入有效的電子郵件地址' });

        const user = await database.createUser({ username, email, password, avatarData: avatar });

        try {
            await emailService.sendVerificationEmail(email, username, user.verificationCode);
            res.status(201).json({ success: true, message: '註冊成功！驗證郵件已發送', user: { id: user.id, username, email } });
        } catch (emailError) {
            console.error('發送驗證郵件失敗:', emailError);
            res.status(201).json({ success: true, message: '註冊成功！但驗證郵件發送失敗，請稍後重新發送', user: { id: user.id, username, email }, emailError: true });
        }
    } catch (error) {
        if (error.message === 'EMAIL_EXISTS') return res.status(409).json({ error: 'EMAIL_EXISTS', message: '此電子郵件已被註冊' });
        res.status(500).json({ error: 'REGISTRATION_FAILED', message: '註冊失敗，請稍後再試' });
    }
});

app.post('/api/verify-email', authLimiter, async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) return res.status(400).json({ error: 'MISSING_FIELDS', message: '請提供電子郵件和驗證碼' });

        const result = await database.verifyUser(email, code);
        try {
            const user = await database.getUserById(result.userId);
            await emailService.sendWelcomeEmail(email, user.username);
        } catch (_) {}
        res.json({ success: true, message: '電子郵件驗證成功！' });
    } catch (error) {
        if (error.message === 'USER_NOT_FOUND') return res.status(404).json({ error: 'USER_NOT_FOUND', message: '找不到用戶' });
        if (error.message === 'INVALID_CODE') return res.status(400).json({ error: 'INVALID_CODE', message: '驗證碼錯誤' });
        if (error.message === 'CODE_EXPIRED') return res.status(400).json({ error: 'CODE_EXPIRED', message: '驗證碼已過期，請重新發送' });
        res.status(500).json({ error: 'VERIFICATION_FAILED', message: '驗證失敗，請稍後再試' });
    }
});

app.post('/api/resend-verification', authLimiter, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'MISSING_EMAIL', message: '請提供電子郵件地址' });

        const result = await database.resendVerificationCode(email);
        let username = '用戶';
        try {
            await new Promise((resolve, reject) => {
                database.db.get('SELECT username FROM users WHERE email = ?', [email], (err, row) => {
                    if (err) return reject(err);
                    if (row && row.username) username = row.username;
                    resolve();
                });
            });
        } catch (_) {}
        await emailService.sendVerificationEmail(email, username, result.verificationCode);
        res.json({ success: true, message: '驗證碼已重新發送' });
    } catch (error) {
        if (error.message === 'USER_NOT_FOUND_OR_VERIFIED') return res.status(404).json({ error: 'USER_NOT_FOUND_OR_VERIFIED', message: '找不到用戶或用戶已驗證' });
        res.status(500).json({ error: 'RESEND_FAILED', message: '重發驗證碼失敗，請稍後再試' });
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'MISSING_FIELDS', message: '請填寫電子郵件和密碼' });

        const user = await database.authenticateUser(email, password);
        const token = jwt.sign({ userId: user.id, email: user.email, username: user.username }, config.server.jwtSecret, { expiresIn: '7d' });
        res.json({ success: true, message: '登入成功', token, user: { id: user.id, username: user.username, email: user.email, avatar: user.avatar } });
    } catch (error) {
        if (error.message === 'USER_NOT_FOUND' || error.message === 'INVALID_PASSWORD') {
            return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '電子郵件或密碼錯誤' });
        }
        if (error.message === 'EMAIL_NOT_VERIFIED') return res.status(403).json({ error: 'EMAIL_NOT_VERIFIED', message: '請先驗證您的電子郵件' });
        res.status(500).json({ error: 'LOGIN_FAILED', message: '登入失敗，請稍後再試' });
    }
});

app.get('/api/user', authenticateToken, async (req, res) => {
    try {
        const user = await database.getUserById(req.user.userId);
        res.json({ success: true, user: { id: user.id, username: user.username, email: user.email, avatar: user.avatar, isVerified: user.isVerified } });
    } catch (error) {
        res.status(500).json({ error: 'GET_USER_FAILED', message: '獲取用戶資訊失敗' });
    }
});

// 靜態文件服務（頭像）
app.use('/uploads', express.static(uploadsDir));

// 錯誤處理中間件
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'FILE_TOO_LARGE', message: '文件大小不能超過5MB' });
    }
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: '服務器內部錯誤' });
});

module.exports = app;


