// 全局變數
let currentUser = null;
let pendingUser = null; // 等待驗證的用戶
let authToken = null;
// 動作鎖（避免重複觸發/誤觸）
let isLoggingIn = false;
let isRegistering = false;
let isVerifying = false;
let isResending = false;

// API 配置
const API_BASE_URL = '/api';

// 頁面載入時初始化
document.addEventListener('DOMContentLoaded', function() {
    initializeAuth();
    setupFormHandlers();
    // 若 OAuth 回跳夾帶 token，寫入後清除 URL
    const url = new URL(window.location.href);
    const t = url.searchParams.get('token');
    if (t) {
        try {
            localStorage.setItem('authToken', t);
            url.searchParams.delete('token');
            window.history.replaceState({}, document.title, url.pathname + url.search);
            // 拉取個人資料並更新 UI
            (async ()=>{
                authToken = t;
                const resp = await fetch(`${API_BASE_URL}/user`, { headers: { Authorization: `Bearer ${authToken}` } });
                if (resp.ok) {
                    const data = await resp.json();
                    currentUser = data.user;
                    updateUIForLoggedInUser();
                    showAlert(`歡迎回來，${currentUser.username}！`, 'success');
                }
            })();
        } catch (_) {}
    }
});

// 初始化認證狀態
async function initializeAuth() {
    // 檢查是否有保存的登入令牌
    authToken = localStorage.getItem('authToken');
    if (authToken) {
        try {
            // 驗證令牌並獲取用戶資訊
            const response = await fetch(`${API_BASE_URL}/user`, {
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                currentUser = data.user;
                updateUIForLoggedInUser();
            } else {
                // 令牌無效，清除本地存儲
                localStorage.removeItem('authToken');
                authToken = null;
            }
        } catch (error) {
            console.error('驗證令牌失敗:', error);
            localStorage.removeItem('authToken');
            authToken = null;
        }
    }
}

// 設置表單處理器
function setupFormHandlers() {
    // 登入表單
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    
    // 註冊表單
    document.getElementById('registerForm').addEventListener('submit', handleRegister);

    // 登入/註冊/登出 按鈕
    const loginBtn = document.getElementById('loginBtn');
    if (loginBtn) loginBtn.addEventListener('click', showLogin);

    const registerBtn = document.getElementById('registerBtn');
    if (registerBtn) registerBtn.addEventListener('click', showRegister);

    const googleOAuthLink = document.getElementById('googleOAuthLink');
    if (googleOAuthLink) googleOAuthLink.addEventListener('click', (e)=>{ e.preventDefault(); startGoogleOAuth(); });

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', logout);

    // 關閉彈窗按鈕（右上角X）
    document.querySelectorAll('.close').forEach(closeEl => {
        closeEl.addEventListener('click', () => {
            const modalId = closeEl.getAttribute('data-modal-id');
            if (modalId) closeModal(modalId);
        });
    });

    // 切換登入/註冊連結
    const switchToRegisterLink = document.getElementById('switchToRegisterLink');
    if (switchToRegisterLink) switchToRegisterLink.addEventListener('click', (e) => { e.preventDefault(); switchToRegister(); });

    const switchToLoginLink = document.getElementById('switchToLoginLink');
    if (switchToLoginLink) switchToLoginLink.addEventListener('click', (e) => { e.preventDefault(); switchToLogin(); });

    // 頭像上傳預覽
    const avatarInput = document.getElementById('avatarInput');
    if (avatarInput) avatarInput.addEventListener('change', (e) => previewAvatar(e.target));

    // 驗證與重發
    const verifyBtn = document.getElementById('verifyBtn');
    if (verifyBtn) verifyBtn.addEventListener('click', verifyCode);

    const resendBtn = document.getElementById('resendBtn');
    if (resendBtn) resendBtn.addEventListener('click', (e) => { e.preventDefault(); resendCode(); });

    // 點擊彈窗外部關閉
    window.addEventListener('click', function(event) {
        const modals = document.querySelectorAll('.modal');
        modals.forEach(modal => {
            if (event.target === modal) {
                closeModal(modal.id);
            }
        });
    });
}
// 開始 Google 登入流程（彈出 Google OAuth 頁面取得 ID Token）
function startGoogleOAuth() {
    const envMeta = document.querySelector('meta[name="google-client-id"]');
    const clientId = window.GOOGLE_CLIENT_ID || (envMeta && envMeta.content) || '';
    const redirectUri = `${location.origin}/api/auth/google/callback`;
    if (!clientId) { showAlert('缺少 GOOGLE_CLIENT_ID'); return; }
    const scope = encodeURIComponent('openid email profile');
    const state = encodeURIComponent(Math.random().toString(36).slice(2));
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&include_granted_scopes=true&state=${state}&prompt=select_account`;
    window.location.href = url;
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

function getGoogleClientId() {
    // 從全域或 <meta name="google-client-id" content="..."> 讀取
    const meta = document.querySelector('meta[name="google-client-id"]');
    return window.GOOGLE_CLIENT_ID || (meta && meta.content) || '';
}

// 其餘 GIS One-Tap 相關已移除，改用 OAuth 授權碼流程

// 顯示登入彈窗
function showLogin() {
    closeAllModals();
    document.body.classList.add('modal-open');
    document.getElementById('loginModal').classList.add('show');
    document.getElementById('loginEmail').focus();
}

// 顯示註冊彈窗
function showRegister() {
    closeAllModals();
    document.body.classList.add('modal-open');
    document.getElementById('registerModal').classList.add('show');
    document.getElementById('registerUsername').focus();
}

// 關閉彈窗
function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('show');
    // 當所有彈窗都關閉時，解除鎖定
    const anyOpen = Array.from(document.querySelectorAll('.modal')).some(m => m.classList.contains('show'));
    if (!anyOpen) {
        document.body.classList.remove('modal-open');
    }
}

// 關閉所有彈窗
function closeAllModals() {
    const modals = document.querySelectorAll('.modal');
    modals.forEach(modal => {
        modal.classList.remove('show');
    });
    document.body.classList.remove('modal-open');
}

// 切換到註冊
function switchToRegister() {
    closeModal('loginModal');
    showRegister();
}

// 切換到登入
function switchToLogin() {
    closeModal('registerModal');
    showLogin();
}

// 頭像預覽
function previewAvatar(input) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            document.getElementById('avatarPreview').src = e.target.result;
        };
        reader.readAsDataURL(input.files[0]);
    }
}

// 產生內嵌SVG頭像，避免外部請求
function generateAvatarDataUrl(initial) {
    const safe = (initial || 'U').toUpperCase().slice(0, 1);
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'>
  <defs>
    <linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
      <stop offset='0%' stop-color='#667eea'/>
      <stop offset='100%' stop-color='#764ba2'/>
    </linearGradient>
  </defs>
  <rect width='100' height='100' fill='url(#g)' rx='16'/>
  <text x='50' y='58' font-family='Arial, sans-serif' font-size='44' fill='white' text-anchor='middle' dominant-baseline='middle'>${safe}</text>
  <!-- padding tweak -->
  <rect width='100' height='100' fill='transparent'/>
  <text x='50' y='52' font-family='Arial, sans-serif' font-size='44' fill='white' text-anchor='middle'>${safe}</text>
</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// 處理註冊
async function handleRegister(event) {
    event.preventDefault();
    if (isRegistering) return; // 節流
    
    const username = document.getElementById('registerUsername').value.trim();
    const email = document.getElementById('registerEmail').value.trim();
    const password = document.getElementById('registerPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const avatarFile = document.getElementById('avatarInput') ? document.getElementById('avatarInput').files[0] : null;
    
    // 表單驗證
    if (!validateRegisterForm(username, email, password, confirmPassword)) {
        return;
    }
    
    try {
        // 處理頭像
        let avatarDataUrl = generateAvatarDataUrl(username.charAt(0));
        if (avatarFile) {
            avatarDataUrl = await fileToBase64(avatarFile);
        }
        
        // 動作鎖與禁用註冊按鈕
        isRegistering = true;
        const submitBtn = document.querySelector('#registerForm button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = '註冊中...';

        // 發送註冊請求到後端
        const response = await fetch(`${API_BASE_URL}/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username,
                email,
                password,
                avatar: avatarDataUrl
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || '註冊失敗');
        }

        // 註冊成功，保存待驗證用戶資訊
        pendingUser = {
            username,
            email
        };

        // 顯示驗證彈窗
        closeModal('registerModal');
        showVerificationModal(email);
        
        // 顯示成功訊息
        if (data.emailError) {
            showAlert('註冊成功！但驗證郵件發送失敗，請稍後重新發送', 'success');
        } else {
            showAlert('註冊成功！請檢查您的郵箱並輸入驗證碼', 'success');
        }

    } catch (error) {
        console.error('註冊錯誤:', error);
        showAlert(error.message || '註冊失敗，請稍後再試');
    } finally {
        // 恢復註冊按鈕與動作鎖
        const submitBtn = document.querySelector('#registerForm button[type="submit"]');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '註冊';
        }
        isRegistering = false;
    }
}

// 驗證註冊表單
function validateRegisterForm(username, email, password, confirmPassword) {
    if (!username || username.length < 2) {
        showAlert('使用者名稱至少需要2個字元');
        return false;
    }
    
    if (!isValidEmail(email)) {
        showAlert('請輸入有效的電子郵件地址');
        return false;
    }
    
    if (password.length < 6) {
        showAlert('密碼至少需要6個字元');
        return false;
    }
    
    if (password !== confirmPassword) {
        showAlert('密碼與確認密碼不符');
        return false;
    }
    
    return true;
}

// 註：email存在檢查現在由後端處理

// 驗證email格式
function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

// 文件轉base64
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
    });
}

// 註：驗證碼發送現在由後端處理，會發送真實郵件

// 顯示驗證彈窗
function showVerificationModal(email) {
    document.getElementById('verificationEmail').textContent = email;
    document.getElementById('verificationModal').classList.add('show');
    document.getElementById('verificationCode').focus();
}

// 驗證驗證碼
async function verifyCode() {
    if (isVerifying) return; // 節流
    const inputCode = document.getElementById('verificationCode').value.trim();
    
    if (!inputCode) {
        showAlert('請輸入驗證碼');
        return;
    }
    
    if (!pendingUser || !pendingUser.email) {
        showAlert('驗證會話已過期，請重新註冊');
        closeModal('verificationModal');
        return;
    }
    
    try {
        // 動作鎖與禁用驗證按鈕
        isVerifying = true;
        const verifyBtn = document.querySelector('#verificationModal button');
        verifyBtn.disabled = true;
        verifyBtn.textContent = '驗證中...';

        // 發送驗證請求到後端
        const response = await fetch(`${API_BASE_URL}/verify-email`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: pendingUser.email,
                code: inputCode
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || '驗證失敗');
        }

        // 驗證成功
        closeModal('verificationModal');
        showAlert('電子郵件驗證成功！請登入您的帳號', 'success');
        
        // 清理待驗證用戶資料
        const email = pendingUser.email;
        pendingUser = null;
        
        // 顯示登入彈窗並預填email
        setTimeout(() => {
            showLogin();
            document.getElementById('loginEmail').value = email;
        }, 1500);

    } catch (error) {
        console.error('驗證錯誤:', error);
        showAlert(error.message || '驗證失敗，請稍後再試');
    } finally {
        // 恢復驗證按鈕與動作鎖
        const verifyBtn = document.querySelector('#verificationModal button');
        verifyBtn.disabled = false;
        verifyBtn.textContent = '驗證';
        isVerifying = false;
    }
}

// 重新發送驗證碼
async function resendCode() {
    if (isResending) return; // 節流
    if (!pendingUser || !pendingUser.email) {
        showAlert('驗證會話已過期，請重新註冊');
        return;
    }

    try {
        // 動作鎖與禁用重發按鈕
        isResending = true;
        const resendBtn = document.getElementById('resendBtn') || document.querySelector('.btn-link');
        resendBtn.disabled = true;
        resendBtn.textContent = '發送中...';

        const response = await fetch(`${API_BASE_URL}/resend-verification`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: pendingUser.email
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || '重發驗證碼失敗');
        }

        showAlert('驗證碼已重新發送到您的郵箱', 'success');

    } catch (error) {
        console.error('重發驗證碼錯誤:', error);
        showAlert(error.message || '重發驗證碼失敗，請稍後再試');
    } finally {
        // 恢復重發按鈕與動作鎖
        const resendBtn = document.getElementById('resendBtn') || document.querySelector('.btn-link');
        resendBtn.disabled = false;
        resendBtn.textContent = '重新發送驗證碼';
        isResending = false;
    }
}

// 註：用戶數據現在由後端數據庫管理

// 處理登入
async function handleLogin(event) {
    event.preventDefault();
    if (isLoggingIn) return; // 節流，避免重複觸發
    
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    
    if (!email || !password) {
        showAlert('請填寫所有欄位');
        return;
    }
    
    try {
        // 設定動作鎖與禁用登入按鈕
        isLoggingIn = true;
        const submitBtn = document.querySelector('#loginForm button[type="submit"]');
        const originalText = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = '登入中...';

        // 發送登入請求到後端
        const response = await fetch(`${API_BASE_URL}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email,
                password
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || '登入失敗');
        }

        // 登入成功
        authToken = data.token;
        currentUser = data.user;
        
        // 保存令牌到本地存儲
        localStorage.setItem('authToken', authToken);
        
        closeModal('loginModal');
        updateUIForLoggedInUser();
        
        showAlert(`歡迎回來，${currentUser.username}！`, 'success');

    } catch (error) {
        console.error('登入錯誤:', error);
        showAlert(error.message || '登入失敗，請稍後再試');
    } finally {
        // 恢復登入按鈕與動作鎖
        const submitBtn = document.querySelector('#loginForm button[type="submit"]');
        submitBtn.disabled = false;
        submitBtn.textContent = '登入';
        isLoggingIn = false;
    }
}

// 更新UI為已登入狀態
function updateUIForLoggedInUser() {
    // 隱藏登入/註冊按鈕
    document.getElementById('authButtons').style.display = 'none';
    
    // 顯示用戶資訊
    const userInfo = document.getElementById('userInfo');
    const userAvatar = document.getElementById('userAvatar');
    const userName = document.getElementById('userName');
    
    userAvatar.src = currentUser.avatar;
    userName.textContent = currentUser.username;
    userInfo.style.display = 'flex';
    
    // 更新歡迎訊息
    const welcomeSection = document.getElementById('welcomeSection');
    welcomeSection.innerHTML = `
        <h1>歡迎回來，${currentUser.username}！</h1>
        <p>您已成功登入 FayCR連線室</p>
    `;
}

// 登出
function logout() {
    // 清理所有認證相關數據
    currentUser = null;
    authToken = null;
    localStorage.removeItem('authToken');
    
    // 重置UI
    document.getElementById('authButtons').style.display = 'flex';
    document.getElementById('userInfo').style.display = 'none';
    
    // 重置歡迎訊息
    const welcomeSection = document.getElementById('welcomeSection');
    welcomeSection.innerHTML = `
        <h1>歡迎來到 FayCR連線室</h1>
        <p>請登入或註冊以開始使用</p>
    `;
    
    showAlert('已成功登出', 'success');
}

// 顯示提示訊息
function showAlert(message, type = 'error') {
    // 移除現有的提示
    const existingAlert = document.querySelector('.alert');
    if (existingAlert) {
        existingAlert.remove();
    }
    
    // 創建新提示
    const alert = document.createElement('div');
    alert.className = `alert alert-${type}`;
    alert.innerHTML = `
        <div class="alert-content">
            <i class="fas ${type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'}"></i>
            <span>${message}</span>
            <button class="alert-close" onclick="this.parentElement.parentElement.remove()">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `;
    
    // 添加樣式
    alert.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 10000;
        background: ${type === 'success' ? '#10b981' : '#ef4444'};
        color: white;
        padding: 1rem 1.5rem;
        border-radius: 10px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
        animation: slideInFromRight 0.3s ease;
        max-width: 400px;
        word-wrap: break-word;
    `;
    
    document.body.appendChild(alert);
    
    // 自動移除
    setTimeout(() => {
        if (alert.parentElement) {
            alert.style.animation = 'slideOutToRight 0.3s ease';
            setTimeout(() => alert.remove(), 300);
        }
    }, 5000);
}

// 添加動畫樣式
const alertStyles = document.createElement('style');
alertStyles.textContent = `
    .alert-content {
        display: flex;
        align-items: center;
        gap: 0.8rem;
    }
    
    .alert-close {
        background: none;
        border: none;
        color: white;
        cursor: pointer;
        padding: 0.2rem;
        border-radius: 3px;
        transition: background 0.2s;
    }
    
    .alert-close:hover {
        background: rgba(255, 255, 255, 0.2);
    }
    
    @keyframes slideInFromRight {
        from {
            opacity: 0;
            transform: translateX(100%);
        }
        to {
            opacity: 1;
            transform: translateX(0);
        }
    }
    
    @keyframes slideOutToRight {
        from {
            opacity: 1;
            transform: translateX(0);
        }
        to {
            opacity: 0;
            transform: translateX(100%);
        }
    }
`;
document.head.appendChild(alertStyles);

// 鍵盤快捷鍵
document.addEventListener('keydown', function(event) {
    // ESC 關閉彈窗
    if (event.key === 'Escape') {
        closeAllModals();
    }
    
    // Enter 在驗證碼輸入框中驗證
    if (event.key === 'Enter' && event.target.id === 'verificationCode') {
        verifyCode();
    }
});

// 表單實時驗證
document.addEventListener('input', function(event) {
    const input = event.target;
    
    // 密碼確認驗證
    if (input.id === 'confirmPassword' || input.id === 'registerPassword') {
        const password = document.getElementById('registerPassword').value;
        const confirmPassword = document.getElementById('confirmPassword').value;
        const confirmInput = document.getElementById('confirmPassword');
        
        if (confirmPassword && password !== confirmPassword) {
            confirmInput.style.borderColor = '#ef4444';
        } else {
            confirmInput.style.borderColor = '';
        }
    }
    
    // 郵件格式驗證
    if (input.type === 'email') {
        if (input.value && !isValidEmail(input.value)) {
            input.style.borderColor = '#ef4444';
        } else {
            input.style.borderColor = '';
        }
    }
    
    // 驗證碼只允許數字
    if (input.id === 'verificationCode') {
        input.value = input.value.replace(/[^0-9]/g, '');
    }
});

// 防止表單默認提交
document.querySelectorAll('form').forEach(form => {
    form.addEventListener('submit', function(event) {
        event.preventDefault();
    });
});

console.log('FayCRChat 認證系統已初始化');
