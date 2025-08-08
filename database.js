const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');

const sql = neon(process.env.DATABASE_URL);

async function ensureTables() {
    await sql`
        create table if not exists users (
            id serial primary key,
            username text not null,
            email text unique not null,
            password_hash text not null,
            avatar_data text,
            is_verified boolean default false,
            verification_code text,
            verification_expires bigint,
            created_at timestamptz default now(),
            updated_at timestamptz default now()
        )
    `;
}

class Database {
    constructor() {
        // best-effort 初始化
        this._init = ensureTables().catch(() => {});
    }

    async createUser({ username, email, password, avatarData }) {
        await this._init;

        const exists = await sql`select id from users where email = ${email}`;
        if (exists.length) throw new Error('EMAIL_EXISTS');

        const passwordHash = await bcrypt.hash(password, 12);
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        const verificationExpires = Date.now() + 15 * 60 * 1000;

        const rows = await sql`
            insert into users (username, email, password_hash, avatar_data, verification_code, verification_expires)
            values (${username}, ${email}, ${passwordHash}, ${avatarData || null}, ${verificationCode}, ${verificationExpires})
            returning id
        `;
        const id = rows[0].id;
        return { id, username, email, verificationCode, verificationExpires };
    }

    async verifyUser(email, code) {
        await this._init;
        const rows = await sql`select id, verification_code, verification_expires from users where email = ${email}`;
        if (!rows.length) throw new Error('USER_NOT_FOUND');
        const u = rows[0];
        if (u.verification_code !== code) throw new Error('INVALID_CODE');
        if (Date.now() > Number(u.verification_expires)) throw new Error('CODE_EXPIRED');

        await sql`update users set is_verified = true, verification_code = null, verification_expires = null, updated_at = now() where id = ${u.id}`;
        return { success: true, userId: u.id };
    }

    async authenticateUser(email, password) {
        await this._init;
        const rows = await sql`select id, username, email, password_hash, avatar_data, is_verified from users where email = ${email}`;
        if (!rows.length) throw new Error('USER_NOT_FOUND');
        const u = rows[0];
        if (!u.is_verified) throw new Error('EMAIL_NOT_VERIFIED');
        const ok = await bcrypt.compare(password, u.password_hash);
        if (!ok) throw new Error('INVALID_PASSWORD');
        return { id: u.id, username: u.username, email: u.email, avatar: u.avatar_data };
    }

    async resendVerificationCode(email) {
        await this._init;
        const rows = await sql`select id, is_verified from users where email = ${email}`;
        if (!rows.length || rows[0].is_verified) throw new Error('USER_NOT_FOUND_OR_VERIFIED');
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        const verificationExpires = Date.now() + 15 * 60 * 1000;
        await sql`update users set verification_code = ${verificationCode}, verification_expires = ${verificationExpires}, updated_at = now() where email = ${email}`;
        return { verificationCode, verificationExpires };
    }

    async getUserById(id) {
        await this._init;
        const rows = await sql`select id, username, email, avatar_data, is_verified from users where id = ${id}`;
        if (!rows.length) throw new Error('USER_NOT_FOUND');
        const u = rows[0];
        return { id: u.id, username: u.username, email: u.email, avatar: u.avatar_data, isVerified: u.is_verified };
    }

    async close() {}
}

module.exports = Database;
