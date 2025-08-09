const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const fetch = global.fetch || require('node-fetch');

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
// 在 Vercel/Proxy 環境下，必須信任代理，否則 rate-limit 會報 X-Forwarded-For 錯誤
app.set('trust proxy', 1);

// 初始化數據庫和郵件服務
const database = new Database(config.database.filename);
const emailService = new EmailService(config.email);

// Google OAuth 客戶端（授權碼流程）
const googleOAuthClient = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.PUBLIC_BASE_URL || ''}/api/auth/google/callback`
);

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

// 本地開發時提供靜態檔案（Vercel 函式中不會使用到檔案系統）
// 注意：Vercel Serverless 環境為唯讀，請勿在 /var/task 下寫入檔案

// 不在 Serverless 中做磁碟上傳；頭像以 base64 存入資料庫

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
    res.json({ status: 'ok', message: 'FayCRChat 後端服務運行中', timestamp: new Date().toISOString() });
});

// 提供前端需要的公開環境變數（不包含敏感值）
app.get('/api/env', (req, res) => {
    res.json({
        googleClientId: process.env.GOOGLE_CLIENT_ID || '',
        discordClientId: process.env.DISCORD_CLIENT_ID || ''
    });
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

// Step 1: 前端導向 Google 授權頁（前端已組好URL）

// Step 2: 授權碼 callback（交換 token 並登入/註冊）
app.get('/api/auth/google/callback', async (req, res) => {
    try {
        const code = req.query.code;
        if (!code) return res.status(400).send('Missing code');

        const r = await googleOAuthClient.getToken({ code });
        const idToken = r.tokens.id_token;
        if (!idToken) return res.status(500).send('No id_token');

        const ticket = await googleOAuthClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const email = payload.email;
        const username = payload.name || email.split('@')[0];
        const avatar = payload.picture || null;

        // 嘗試查詢/建立使用者
        const sql = require('@neondatabase/serverless').neon(process.env.DATABASE_URL);
        let rows = await sql`select id, username, email, avatar_data, is_verified from users where email = ${email}`;
        let userRow = rows[0];
        if (!userRow) {
            const created = await database.createUser({ username, email, password: Math.random().toString(36), avatarData: avatar });
            await database.verifyUser(email, created.verificationCode);
            rows = await sql`select id, username, email, avatar_data, is_verified from users where email = ${email}`;
            userRow = rows[0];
        }
        // 覆蓋頭像
        if (avatar && userRow && userRow.avatar_data !== avatar) {
            await sql`update users set avatar_data = ${avatar} where email = ${email}`;
            userRow.avatar_data = avatar;
        }

        const token = jwt.sign({ userId: userRow.id, email: userRow.email, username: userRow.username }, config.server.jwtSecret, { expiresIn: '7d' });
        // 改用 302 導回首頁，將 token 放在查詢參數，避免 inline script 觸發 CSP
        return res.redirect(`/?token=${encodeURIComponent(token)}`);
    } catch (e) {
        console.error('Google OAuth callback error:', e);
        return res.status(500).send('Google OAuth Failed');
    }
});

// Discord OAuth callback：交換 token、拿使用者資料，並嘗試加入指定伺服器
app.get('/api/auth/discord/callback', async (req, res) => {
    try {
        const code = req.query.code;
        if (!code) return res.status(400).send('Missing code');

        const redirectUri = `${process.env.PUBLIC_BASE_URL || ''}/api/auth/discord/callback`;
        // 交換 token
        const tokenResp = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri
            })
        });
        if (!tokenResp.ok) {
            const txt = await tokenResp.text();
            return res.status(500).send('Discord token exchange failed: ' + txt);
        }
        const tokenData = await tokenResp.json();
        const accessToken = tokenData.access_token;

        // 取得使用者資料
        const userResp = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (!userResp.ok) {
            const txt = await userResp.text();
            return res.status(500).send('Discord user fetch failed: ' + txt);
        }
        const u = await userResp.json();
        const email = u.email || `${u.id}@discord.local`; // 若未授權 email，使用臨時郵件
        const username = u.global_name || u.username || 'DiscordUser';
        const avatar = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : null;

        // 查詢/建立本地使用者
        const sql = require('@neondatabase/serverless').neon(process.env.DATABASE_URL);
        let rows = await sql`select id, username, email, avatar_data, is_verified from users where email = ${email}`;
        let userRow = rows[0];
        if (!userRow) {
            const created = await database.createUser({ username, email, password: Math.random().toString(36), avatarData: avatar });
            await database.verifyUser(email, created.verificationCode);
            rows = await sql`select id, username, email, avatar_data, is_verified from users where email = ${email}`;
            userRow = rows[0];
        }
        if (avatar && userRow && userRow.avatar_data !== avatar) {
            await sql`update users set avatar_data = ${avatar} where email = ${email}`;
            userRow.avatar_data = avatar;
        }

        // 嘗試讓使用者加入指定伺服器（需 Bot Token 並且 bot 在該伺服器，且有 guilds.join scope）
        // 注意：Discord 已不再允許純 OAuth user token 直接加 guild，需透過 Bot 的 OAuth2 與 Add Guild Member API
        // 這裡提供示範：若提供 DISCORD_GUILD_ID 與 DISCORD_BOT_TOKEN，則嘗試加入
        if (process.env.DISCORD_GUILD_ID && process.env.DISCORD_BOT_TOKEN) {
            try {
                const joinResp = await fetch(`https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${u.id}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`
                    },
                    body: JSON.stringify({
                        access_token: accessToken
                    })
                });
                // 201/204 表成功；若失敗可忽略不阻斷登入
            } catch (_) {}
        }

        const token = jwt.sign({ userId: userRow.id, email: userRow.email, username: userRow.username }, config.server.jwtSecret, { expiresIn: '7d' });
        return res.redirect(`/?token=${encodeURIComponent(token)}`);
    } catch (e) {
        console.error('Discord OAuth callback error:', e);
        return res.status(500).send('Discord OAuth Failed');
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

// 更新個人資料（名稱、頭像）
app.post('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const { username, avatar } = req.body;
        if (!username) return res.status(400).json({ error: 'INVALID_USERNAME', message: '暱稱不可為空' });
        const sql = require('@neondatabase/serverless').neon(process.env.DATABASE_URL);
        await sql`update users set username = ${username}, avatar_data = ${avatar || null} where id = ${req.user.userId}`;
        res.json({ success: true });
    } catch (e) {
        console.error('更新個人資料錯誤:', e);
        res.status(500).json({ error: 'PROFILE_UPDATE_FAILED', message: '更新失敗' });
    }
});

// 取消 /uploads 靜態服務（Serverless 無檔案系統）

// 錯誤處理中間件
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'FILE_TOO_LARGE', message: '文件大小不能超過5MB' });
    }
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: '服務器內部錯誤' });
});

module.exports = app;


