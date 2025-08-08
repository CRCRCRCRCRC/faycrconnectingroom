const { kv } = require('@vercel/kv');
const bcrypt = require('bcryptjs');

class Database {
    // 以 KV 實作
    async createUser({ username, email, password, avatarData }) {
        const existing = await kv.get(`user:${email}`);
        if (existing) throw new Error('EMAIL_EXISTS');

        const passwordHash = await bcrypt.hash(password, 12);
        const id = await kv.incr('seq:userId');

        const user = {
            id,
            username,
            email,
            passwordHash,
            avatar: avatarData || null,
            isVerified: false,
            createdAt: Date.now()
        };

        // 驗證碼（15分鐘）
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        await kv.set(`verify:${email}`, verificationCode, { ex: 15 * 60 });

        await kv.set(`user:${email}`, user);
        await kv.set(`userId:${id}`, email);

        return { id, username, email, verificationCode };
    }

    async verifyUser(email, code) {
        const saved = await kv.get(`verify:${email}`);
        if (!saved) throw new Error('CODE_EXPIRED');
        if (saved !== code) throw new Error('INVALID_CODE');

        const user = await kv.get(`user:${email}`);
        if (!user) throw new Error('USER_NOT_FOUND');

        user.isVerified = true;
        await kv.set(`user:${email}`, user);
        await kv.del(`verify:${email}`);
        return { success: true, userId: user.id };
    }

    async authenticateUser(email, password) {
        const user = await kv.get(`user:${email}`);
        if (!user) throw new Error('USER_NOT_FOUND');
        if (!user.isVerified) throw new Error('EMAIL_NOT_VERIFIED');
        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) throw new Error('INVALID_PASSWORD');
        return { id: user.id, username: user.username, email: user.email, avatar: user.avatar };
    }

    async resendVerificationCode(email) {
        const user = await kv.get(`user:${email}`);
        if (!user || user.isVerified) throw new Error('USER_NOT_FOUND_OR_VERIFIED');
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        await kv.set(`verify:${email}`, verificationCode, { ex: 15 * 60 });
        return { verificationCode };
    }

    async getUserById(id) {
        const email = await kv.get(`userId:${id}`);
        if (!email) throw new Error('USER_NOT_FOUND');
        const user = await kv.get(`user:${email}`);
        if (!user) throw new Error('USER_NOT_FOUND');
        return { id: user.id, username: user.username, email: user.email, avatar: user.avatar, isVerified: user.isVerified };
    }

    async close() {}
}

module.exports = Database;
