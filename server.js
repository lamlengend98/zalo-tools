#!/usr/bin/env node
/**
 * server.js — Web UI cho việc chọn & rời nhiều nhóm Zalo cùng lúc, dùng chung
 * cho nhiều người qua 1 link. Backend gọi CLI `openzca`
 * (https://github.com/darkamenosa/openzca) làm nền.
 *
 * KIẾN TRÚC NHIỀU NGƯỜI DÙNG — CHỈ 1 LỚP ĐĂNG NHẬP DUY NHẤT LÀ QR ZALO:
 *   - Không có tài khoản/username/password riêng cho web app.
 *   - Khi 1 trình duyệt/thiết bị vào link lần đầu, server tự gán 1 session
 *     (cookie) và 1 "profile" nội bộ ngẫu nhiên, ẩn hoàn toàn với người dùng.
 *   - Người dùng chỉ thấy và chỉ cần làm 1 việc: quét QR để đăng nhập Zalo.
 *   - Mọi API đều lấy profile từ session cookie của trình duyệt đó — KHÔNG
 *     bao giờ lấy profile từ input do client gửi lên, nên 1 người không thể
 *     xem/thao tác được nhóm của người khác (mỗi trình duyệt = 1 phiên riêng
 *     = 1 tài khoản Zalo riêng).
 *   - Tag của mỗi người lưu riêng tại ~/.openzca-leave-groups/tags/<profile>.json
 *
 * ⚠️ BẮT BUỘC khi deploy cho nhiều người qua mạng thật (không phải chỉ
 * localhost): phải chạy sau HTTPS (reverse proxy như Caddy/Nginx/Cloudflare,
 * hoặc nền tảng hosting có TLS sẵn). Không có HTTPS thì session cookie đi
 * qua mạng ở dạng không mã hoá — ai chặn được mạng có thể giả làm phiên của
 * người khác.
 *
 * Chạy local:
 *   npm install
 *   node server.js
 *   -> mở http://localhost:4545
 */

const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

require("dotenv").config();

const app = express();

// Nếu chạy sau reverse proxy (Nginx/Caddy/Cloudflare) có HTTPS, bật dòng này
// để cookie "secure" hoạt động đúng:
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

app.use(express.json());

// --- Thư mục dữ liệu của app (tách biệt với dữ liệu openzca) ---
const APP_DATA_DIR = path.join(os.homedir(), ".openzca-leave-groups");
const SESSION_SECRET_FILE = path.join(APP_DATA_DIR, "session-secret");
const TAGS_DIR = path.join(APP_DATA_DIR, "tags");

fs.mkdirSync(APP_DATA_DIR, { recursive: true });
fs.mkdirSync(TAGS_DIR, { recursive: true });

function getOrCreateSessionSecret() {
    try {
        return fs.readFileSync(SESSION_SECRET_FILE, "utf8").trim();
    } catch (err) {
        const secret = crypto.randomBytes(32).toString("hex");
        fs.writeFileSync(SESSION_SECRET_FILE, secret, "utf8");
        return secret;
    }
}

app.use(
    session({
        secret: getOrCreateSessionSecret(),
        resave: false,
        saveUninitialized: true, // cần true để mỗi trình duyệt có session/profile ngay từ lần đầu
        cookie: {
            httpOnly: true,
            maxAge: 90 * 24 * 60 * 60 * 1000, // 90 ngày
            secure: process.env.COOKIE_SECURE === "1", // bật khi chạy sau HTTPS
            sameSite: "lax",
        },
    })
);

// Tự động gán 1 profile ngẫu nhiên cho mỗi session mới — đây là toàn bộ cơ
// chế "đăng nhập" ở tầng web app, người dùng không nhìn thấy hay thao tác gì.
app.use((req, res, next) => {
    if (!req.session.profile) {
        req.session.profile = `p-${crypto.randomBytes(8).toString("hex")}`;
    }
    next();
});

app.use(express.static(path.join(__dirname, "public")));

// Tên các subcommand openzca — theo tài liệu chính thức. Nếu bản CLI bạn cài
// khác tên lệnh, sửa ở đây.
const AUTH_LOGIN_ARGS = ["auth", "login"];
const AUTH_LOGOUT_ARGS = ["auth", "logout"];
const AUTH_STATUS_ARGS = ["auth", "status"];
const ME_INFO_ARGS = ["me", "info"];

// ---------------- Tag storage (mỗi người 1 file riêng theo profile) ----------------

function tagsFilePath(profile) {
    // profile được sinh tự động (chữ/số/gạch ngang) nên an toàn để dùng làm tên file
    return path.join(TAGS_DIR, `${profile}.json`);
}

function loadTags(profile) {
    try {
        return JSON.parse(fs.readFileSync(tagsFilePath(profile), "utf8"));
    } catch (err) {
        return {};
    }
}

function saveTags(profile, tags) {
    fs.writeFileSync(tagsFilePath(profile), JSON.stringify(tags, null, 2), "utf8");
}

// ---------------- Gọi openzca CLI ----------------

// Dùng binary cài local trong node_modules/.bin (qua dependency "openzca" trong
// package.json) thay vì kỳ vọng lệnh `openzca` có sẵn global trong PATH.
// Lý do: nhiều nền tảng deploy (Render, Railway...) không cho quyền ghi vào
// thư mục npm global khi build (`npm install -g` sẽ lỗi ENOENT/permission).
const localOpenzcaBin = path.join(
    __dirname,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "openzca.cmd" : "openzca"
);
const OPENZCA_BIN = fs.existsSync(localOpenzcaBin) ? localOpenzcaBin : "openzca";

function runOpenzca(cliArgs, profile) {
    return new Promise((resolve, reject) => {
        const finalArgs = ["--profile", profile, ...cliArgs];
        execFile(
            OPENZCA_BIN,
            finalArgs,
            { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) return reject(new Error(stderr || err.message));
                resolve(stdout);
            }
        );
    });
}

// openzca yêu cầu 1 profile phải được tạo trước bằng `account add <name>`
// trước khi dùng được với `--profile <name>` cho bất kỳ lệnh nào khác.
// Hàm này tự tạo profile trong lần đầu tiên gặp (idempotent, im lặng nếu đã
// tồn tại), hoàn toàn ẩn với người dùng — họ không cần biết khái niệm này.
const ensuredProfiles = new Set();

function ensureProfileExists(profile) {
    return new Promise((resolve, reject) => {
        if (ensuredProfiles.has(profile)) return resolve();
        execFile(
            OPENZCA_BIN,
            ["account", "add", profile],
            { encoding: "utf8" },
            (err, stdout, stderr) => {
                const alreadyExists = /already exists/i.test(stderr || "") || /already exists/i.test((err && err.message) || "");
                if (err && !alreadyExists) {
                    return reject(new Error(stderr || err.message));
                }
                ensuredProfiles.add(profile);
                resolve();
            }
        );
    });
}

// Bọc runOpenzca gốc để luôn đảm bảo profile tồn tại trước khi chạy lệnh thật
const rawRunOpenzca = runOpenzca;
runOpenzca = async function (cliArgs, profile) {
    await ensureProfileExists(profile);
    return rawRunOpenzca(cliArgs, profile);
};

function normalizeGroups(raw) {
    const groups = JSON.parse(raw);
    if (!Array.isArray(groups)) return [];
    return groups.map((g) => ({
        id: g.groupId || g.id || g.threadId,
        name: g.name || g.groupName || g.title || "(không tên)",
        memberCount: g.memberCount || g.totalMember || g.totalMembers || null,
    }));
}

function normalizeUser(raw) {
    let data;
    try {
        data = JSON.parse(raw);
    } catch (err) {
        return null;
    }
    const u = data && data.data ? data.data : data;
    if (!u || typeof u !== "object") return null;
    return {
        name: u.name || u.displayName || u.zaloName || u.username || null,
        id: u.userId || u.id || u.uid || null,
        avatar: u.avatar || u.avatarUrl || null,
    };
}

// ---------------- API: danh sách nhóm (kèm tag), chỉ của phiên hiện tại ----------------

app.get("/api/groups", async (req, res) => {
    try {
        const profile = req.session.profile;
        const raw = await runOpenzca(["group", "list", "--json"], profile);
        const groups = normalizeGroups(raw);
        const tags = loadTags(profile);
        const withTags = groups.map((g) => ({ ...g, tags: tags[g.id] || [] }));
        res.json({ groups: withTags });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/tags", (req, res) => {
    res.json({ tags: loadTags(req.session.profile) });
});

app.post("/api/tags", (req, res) => {
    const { groupId, tags: tagList, action } = req.body || {};
    if (!groupId || !Array.isArray(tagList)) {
        return res.status(400).json({ error: "Thiếu groupId hoặc tags[]" });
    }
    const profile = req.session.profile;
    const tags = loadTags(profile);
    const normalized = tagList.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    const existing = new Set(tags[groupId] || []);

    if (action === "remove") {
        normalized.forEach((t) => existing.delete(t));
    } else if (action === "set") {
        existing.clear();
        normalized.forEach((t) => existing.add(t));
    } else {
        normalized.forEach((t) => existing.add(t));
    }

    if (existing.size === 0) delete tags[groupId];
    else tags[groupId] = [...existing];

    saveTags(profile, tags);
    res.json({ tags: tags[groupId] || [] });
});

// ---------------- API: đăng nhập/đăng xuất Zalo qua QR, theo profile của session ----------------

app.get("/api/auth/status", async (req, res) => {
    const profile = req.session.profile;

    const withUserInfo = async () => {
        try {
            const rawUser = await runOpenzca([...ME_INFO_ARGS, "--json"], profile);
            const user = normalizeUser(rawUser);
            return res.json({ loggedIn: true, user });
        } catch (err) {
            return res.json({ loggedIn: true, user: null });
        }
    };

    try {
        await runOpenzca(AUTH_STATUS_ARGS, profile);
        return withUserInfo();
    } catch (err) {
        try {
            await runOpenzca(["group", "list", "--json"], profile);
            return withUserInfo();
        } catch (err2) {
            return res.json({ loggedIn: false, message: err2.message });
        }
    }
});

app.get("/api/auth/login-stream", async (req, res) => {
    const profile = req.session.profile;
    const args = ["--profile", profile, ...AUTH_LOGIN_ARGS];

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
        await ensureProfileExists(profile);
    } catch (err) {
        send({ line: `Không tạo được profile: ${err.message}` });
        send({ done: true, success: false });
        return res.end();
    }

    const child = spawn(OPENZCA_BIN, args, { encoding: "utf8" });

    child.stdout.on("data", (chunk) => send({ line: chunk.toString() }));
    child.stderr.on("data", (chunk) => send({ line: chunk.toString() }));

    child.on("error", (err) => {
        send({ line: `Không chạy được lệnh openzca: ${err.message}` });
        send({ done: true, success: false });
        res.end();
    });

    child.on("close", (code) => {
        send({ done: true, success: code === 0 });
        res.end();
    });

    req.on("close", () => {
        if (!child.killed) child.kill();
    });
});

app.post("/api/auth/logout", async (req, res) => {
    try {
        const out = await runOpenzca(AUTH_LOGOUT_ARGS, req.session.profile);
        res.json({ ok: true, output: out });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------- API: rời nhiều nhóm, chỉ trong profile của session ----------------

app.get("/api/leave-stream", async (req, res) => {
    const profile = req.session.profile;
    const groupIds = String(req.query.groupIds || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const minDelay = parseInt(req.query.minDelay, 10) || 2000;
    const maxDelay = parseInt(req.query.maxDelay, 10) || 4000;
    const dryRun = req.query.dryRun === "1";

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    for (const groupId of groupIds) {
        if (dryRun) {
            send({ groupId, status: "dry-run" });
        } else {
            try {
                await runOpenzca(["group", "leave", groupId], profile);
                send({ groupId, status: "ok" });
            } catch (err) {
                send({ groupId, status: "error", message: err.message });
            }
        }
        const delay = Math.floor(minDelay + Math.random() * (maxDelay - minDelay));
        await new Promise((r) => setTimeout(r, delay));
    }

    send({ done: true });
    res.end();
});

// ---------------- API: bắt đầu phiên mới (đổi sang tài khoản Zalo khác trên cùng trình duyệt) ----------------

app.post("/api/session/reset", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});

const PORT = process.env.PORT || 4545;
app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`openzca-leave-groups web UI đang chạy tại ${url}`);
    console.log("Đăng nhập bằng QR Zalo — không cần tài khoản web app riêng.");
    if (process.env.NODE_ENV !== "production") openBrowser(url);
});

function openBrowser(url) {
    const platform = process.platform;
    try {
        if (platform === "win32") {
            require("child_process").exec(`start "" "${url}"`);
        } else {
            const cmd = platform === "darwin" ? "open" : "xdg-open";
            execFile(cmd, [url], () => { });
        }
    } catch (err) {
        console.log(`Không tự mở được trình duyệt — hãy mở thủ công: ${url}`);
    }
}