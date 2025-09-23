// server.js (DB 백엔드 버전)
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));
app.get("/", (_req, res)=> res.redirect("/public/index.html"));

// --- DB 연결 풀 ---
const pool = mysql.createPool({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  waitForConnections: true, connectionLimit: 10
});

// --- Online user tracking (in-memory) ---
const onlineUsers = new Map(); // id -> connection count
function addOnline(id){ if(!id) return; onlineUsers.set(id,(onlineUsers.get(id)||0)+1); }
function removeOnline(id){
  if(!id) return;
  const c = (onlineUsers.get(id)||0) - 1;
  if (c <= 0) onlineUsers.delete(id); else onlineUsers.set(id, c);
}

// --- Upload (선택적으로 남겨둠) ---
const upload = multer({ storage: multer.memoryStorage() });
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try{
    const [r] = await pool.execute(
      "INSERT INTO uploads(original_name,size,mime,blob,uploader_id) VALUES(?,?,?,?,?)",
      [req.file.originalname, req.file.size, req.file.mimetype || null, req.file.buffer, null]
    );
    return res.json({ name: req.file.originalname, url: `/api/files/${r.insertId}` });
  }catch(e){
    console.error("Upload error:", e);
    res.status(500).json({ message:"upload failed", error: String(e?.message||e) });
  }
});
app.get("/api/files/:id", async (req,res)=>{
  const [rows] = await pool.execute("SELECT original_name,size,mime,blob FROM uploads WHERE id=?", [req.params.id]);
  if(!rows.length) return res.status(404).end();
  const f = rows[0];
  res.setHeader("Content-Type", f.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
  res.end(f.blob);
});

// --- Auth (데모용 평문 PW) ---
app.post("/api/join", async (req,res)=>{
  const { id, pw } = req.body || {};
  if(!id || !pw) return res.status(400).json({ message: "ID/PW 필요" });
  const [exists] = await pool.execute("SELECT 1 FROM users WHERE id=?", [id]);
  if(exists.length) return res.status(409).json({ message: "이미 존재" });
  await pool.execute("INSERT INTO users(id,pw) VALUES(?,?)", [id,pw]);
  res.json({ ok:true });
});
app.post("/api/login", async (req,res)=>{
  const { id, pw } = req.body || {};
  const [rows] = await pool.execute("SELECT pw FROM users WHERE id=?", [id]);
  if(!rows.length || rows[0].pw !== pw) return res.status(401).json({ message:"로그인 실패" });
  res.json({ ok:true });
});

// --- Rooms REST ---
app.get("/api/rooms", async (_req, res)=>{
  const [rows] = await pool.execute(`
    SELECT r.name, (r.pw IS NOT NULL AND r.pw<>'') AS has_pw,
           COALESCE(active.cnt,0) AS members
    FROM rooms r
    LEFT JOIN (
      SELECT room_id, COUNT(*) cnt FROM (
        SELECT DISTINCT room_id, user_id FROM messages
        WHERE ts_ms > (UNIX_TIMESTAMP()*1000 - 5*60*1000)
      ) t GROUP BY room_id
    ) active ON active.room_id = r.id
    WHERE r.deleted_at IS NULL
    ORDER BY r.id DESC
  `);
  res.json(rows.map(r=>({ name:r.name, pw: r.has_pw ? true : "", members: r.members })));
});
app.get("/api/rooms/:name", async (req,res)=>{
  const [rows] = await pool.execute("SELECT pw FROM rooms WHERE name=? AND deleted_at IS NULL", [req.params.name]);
  if(!rows.length) return res.status(404).json({ message:"없음" });
  res.json({ name: req.params.name, pw: rows[0].pw || "" });
});
app.post("/api/rooms", async (req,res)=>{
  const { name, pw } = req.body || {};
  if(!name) return res.status(400).json({ message:"이름 필요" });
  const [dup] = await pool.execute("SELECT 1 FROM rooms WHERE name=? AND deleted_at IS NULL", [name]);
  if(dup.length) return res.status(409).json({ message:"중복" });
  await pool.execute("INSERT INTO rooms(name,pw,created_at) VALUES(?,?,?)", [name, pw||null, Date.now()]);
  io.emit("presence:update", { room:name, members:0, type:"roomCreated" });
  res.json({ ok:true });
});

// --- Admin (아카이브 REST) ---
app.get("/api/admin/users", async (_req,res)=>{
  const [rows] = await pool.execute("SELECT id, pw FROM users ORDER BY id");
  res.json({ users: rows });
});
app.get("/api/admin/deleted", async (_req,res)=>{
  const [rows] = await pool.execute("SELECT room_name AS name, pw, created_at_ms AS createdAt, deleted_at_ms AS deletedAt, reason, message_count, JSON_EXTRACT(members_json, '$') AS membersAtDelete FROM room_archives ORDER BY id DESC");
  res.json(rows.map(r=>({
    name: r.name, pw: r.pw, createdAt: r.createdAt, deletedAt: r.deletedAt,
    reason: r.reason, messageCount: r.message_count, membersAtDelete: JSON.parse(r.membersAtDelete||"[]")
  })));
});
app.get("/api/admin/deleted/:name", async (req,res)=>{
  const [rows] = await pool.execute("SELECT * FROM room_archives WHERE room_name=? ORDER BY id DESC LIMIT 1", [req.params.name]);
  if(!rows.length) return res.status(404).json({ message:"아카이브 없음" });
  const r = rows[0];
  res.json({
    name: r.room_name, pw: r.pw, createdAt: r.created_at_ms, deletedAt: r.deleted_at_ms,
    reason: r.reason, membersAtDelete: JSON.parse(r.members_json||"[]"),
    messageCount: r.message_count, history: JSON.parse(r.history_json||"[]")
  });
});
app.get("/api/admin/deleted/:name/export", async (req,res)=>{
  const [rows] = await pool.execute("SELECT * FROM room_archives WHERE room_name=? ORDER BY id DESC LIMIT 1", [req.params.name]);
  if(!rows.length) return res.status(404).json({ message:"아카이브 없음" });
  const r = rows[0];
  const fname = `${Date.now()}-${r.room_name}-archive.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.json({
    name: r.room_name, pw: r.pw, createdAt: r.created_at_ms, deletedAt: r.deleted_at_ms,
    reason: r.reason, membersAtDelete: JSON.parse(r.members_json||"[]"),
    messageCount: r.message_count, history: JSON.parse(r.history_json||"[]")
  });
});

// --- Socket.IO (방 입장/메시지/퇴장) ---
io.on("connection", (socket)=>{
  // 인증
  socket.on("auth", async ({ user })=>{
    socket.data.user = user;
    addOnline(user);                 // 온라인 유저 +1
    await emitAdminState();          // 전체에 최신 상태 브로드캐스트
  });

  // 어드민 모니터링 요청에 개별 회신
  socket.on("admin:getState", async ()=>{
    try {
      const state = await getAdminState();
      socket.emit("admin:state", state); // 요청 소켓에게만 회신
    } catch (e) {
      console.error("admin:getState error:", e);
    }
  });

  socket.on("room:join", async ({ room, user })=>{
    socket.join(room);
    socket.data.room = room;
    const [r1] = await pool.execute("SELECT id FROM rooms WHERE name=? AND deleted_at IS NULL", [room]);
    let roomId = r1[0]?.id;
    if(!roomId){
      const [ins] = await pool.execute("INSERT INTO rooms(name,created_at) VALUES(?,?)", [room, Date.now()]);
      roomId = ins.insertId;
      io.emit("presence:update", { room, members:0, type:"roomCreated" });
    }
    const [hist] = await pool.execute(`
      SELECT m.user_id AS user, m.ts_ms AS time, m.text,
             CASE WHEN m.file_id IS NULL THEN NULL
                  ELSE JSON_OBJECT('name', u.original_name, 'url', CONCAT('/api/files/', m.file_id), 'size', u.size)
             END AS file
      FROM messages m
      LEFT JOIN uploads u ON u.id = m.file_id
      WHERE m.room_id=? ORDER BY m.id DESC LIMIT 200
    `, [roomId]);
    socket.emit("room:joined", { room, members: getRoomMemberCount(room), history: hist.slice().reverse() });
    io.to(room).emit("presence:update", { room, members: getRoomMemberCount(room), type:"join", user });
  });

  socket.on("chat:message", async ({ room, text, file })=>{
    if(!room || !socket.rooms.has(room)) return;
    const [r1] = await pool.execute("SELECT id FROM rooms WHERE name=? AND deleted_at IS NULL", [room]);
    if(!r1.length) return;
    const roomId = r1[0].id;

    let fileId = null;
    if(file?.url){
      const m = String(file.url).match(/\/api\/files\/(\d+)/);
      if(m) fileId = Number(m[1]);
    }
    const msg = { user: socket.data.user || "unknown", time: Date.now(), text: text||"", file: file || null };
    await pool.execute("INSERT INTO messages(room_id,user_id,ts_ms,text,file_id) VALUES(?,?,?,?,?)",
      [roomId, msg.user, msg.time, msg.text, fileId]);
    io.to(room).emit("chat:message", msg);
  });

  socket.on("room:leave", async ({ room })=>{
    socket.leave(room);
    await maybeArchiveAndDeleteRoom(room);
    io.emit("admin:state", await getAdminState());
    io.to(room).emit("presence:update", { room, members: getRoomMemberCount(room), type:"leave", user: socket.data.user });
  });

  socket.on("disconnect", async ()=>{
    const room = socket.data.room;
    if(room){ await maybeArchiveAndDeleteRoom(room); }
    removeOnline(socket.data.user);  // 온라인 유저 -1
    io.emit("admin:state", await getAdminState());
  });
});

function getRoomMemberCount(room){
  const r = io.sockets.adapter.rooms.get(room);
  return r ? r.size : 0;
}
async function maybeArchiveAndDeleteRoom(roomName){
  const cnt = getRoomMemberCount(roomName);
  if(cnt !== 0) return;
  const [r1] = await pool.execute("SELECT id, name, pw, created_at FROM rooms WHERE name=? AND deleted_at IS NULL", [roomName]);
  if(!r1.length) return;
  const room = r1[0];
  const [mCnt] = await pool.execute("SELECT COUNT(*) AS c FROM messages WHERE room_id=?", [room.id]);
  const [last200] = await pool.execute(`
    SELECT m.user_id AS user, m.ts_ms AS time, m.text,
           CASE WHEN m.file_id IS NULL THEN NULL ELSE JSON_OBJECT('name', u.original_name, 'url', CONCAT('/api/files/', m.file_id), 'size', u.size) END AS file
    FROM messages m LEFT JOIN uploads u ON u.id=m.file_id
    WHERE m.room_id=? ORDER BY m.id DESC LIMIT 200`, [room.id]);
  await pool.execute("UPDATE rooms SET deleted_at=?, delete_reason=? WHERE id=?", [Date.now(), "last_member_left", room.id]);
  await pool.execute(`
    INSERT INTO room_archives(room_name,pw,created_at_ms,deleted_at_ms,reason,members_json,message_count,history_json)
    VALUES(?,?,?,?,?,?,?,?)`,
    [room.name, room.pw || null, room.created_at, Date.now(), "last_member_left", JSON.stringify([]), mCnt[0].c, JSON.stringify(last200.reverse())]
  );
  io.emit("presence:update", { room: room.name, members: 0, type:"roomDeleted" });
}
async function getAdminState(){
  const [rooms] = await pool.execute("SELECT name, (deleted_at IS NULL) AS alive FROM rooms WHERE deleted_at IS NULL ORDER BY id DESC");
  const users = Array.from(onlineUsers.keys())
    .filter(u => u && u !== "admin")
    .sort();
  return {
    rooms: rooms.map(r=>({ name: r.name, members: getRoomMemberCount(r.name) })),
    users,
    deletedCount: (await pool.execute("SELECT COUNT(*) AS c FROM room_archives"))[0][0].c
  };
}
async function emitAdminState(){ io.emit("admin:state", await getAdminState()); }

server.listen(PORT, ()=> console.log("Server on http://localhost:"+PORT));
