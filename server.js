// server.js - minimal realtime chat (dev demo) // 43번 줄 db 구축시 사용하면 됨

// npm i express socket.io multer
const path = require('path'); 
//파일경로 와 디렉토리 조작
const fs = require('fs');
//파일경로 와 디렉토리 조작
const express = require('express');
//HTTP 서버(REST API 제공)
const http = require('http');
//기본 HTTP 서버 객체
const { Server } = require('socket.io');
//웹 소켓 (실시간 채팅
const multer = require('multer');
//파일 업로드 처리

const app = express();
//app:EXpress 앱의 객체
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
//io: socket.io 서버 객체

const PORT = process.env.PORT || 3000;
//port:.env 파일에서 port 값 읽기 .env 파일에 port=4000이라고 적으면 4000번 포트 에서 실행 없으면 기본값 3000번
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));
///public 경로로 들어온 요청은 public 폴더 안 파일 제공
app.get("/", (_req, res)=> res.redirect("/public/index.html"));
/// 들어오면 index.html로 리다이렉

// --- 파일 업로드 처리 ---
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });
app.post("/api/upload", upload.single("file"), (req, res)=>{
  res.json({ name: req.file.originalname, url: `/uploads/${req.file.filename}` });
});
app.use("/uploads", express.static(uploadDir));
//업로드된 파일을 uploads 폴더에 저장 업로드 성공 시 JSON 반환 → 프론트에서 다운로드 링크 표시 가능
// --In-memory 저장소 (데모용) --- #  여기 DB 구축 하면됨
const users = new Map(); // id -> { pw }
const rooms = new Map(); // name -> { pw, members:Set<string userId>, history:[], createdAt:number }
const deletedRooms = []; // archived rooms
const onlineUsers = new Map(); // socket.id -> userId
//users: 회원가입된 유저 (아이디/비번)
//rooms: 생성된 방 목록
//deletedRooms: 나중에 삭제된 방 기록 보관
//onlineUsers: 현재 접속 중인 유저
//지금은 메모리 저장이라 서버 껐다 켜면 다 사라집니다.

// ---회원가입/로그인 API---
app.post("/api/join", (req, res)=>{
  const { id, pw } = req.body || {};
  if(!id || !pw) return res.status(400).json({ message: "ID/PW 필요" });
  if(users.has(id)) return res.status(409).json({ message: "이미 존재" });
  users.set(id, { pw });
  res.json({ ok: true });
});
app.post("/api/login", (req, res)=>{
  const { id, pw } = req.body || {};
  const u = users.get(id);
  if(!u || u.pw !== pw) return res.status(401).json({ message: "로그인 실패" });
  res.json({ ok: true });
});
// /api/join: ID/PW 받아서 users 맵에 저장
// /api/login: ID/PW 확인 → 성공/실패 반환
//비밀번호 암호화(X), 토큰 인증(X) → 순전히 데모용

// ---방 관리 API---
app.get("/api/rooms", (_req, res)=>{
  const list = Array.from(rooms.entries()).map(([name, r])=>({ name, pw: r.pw ? true : "" , members: r.members.size }));
  res.json(list);
});
app.get("/api/rooms/:name", (req, res)=>{
  const r = rooms.get(req.params.name);
  if(!r) return res.status(404).json({ message: "없음" });
  res.json({ name: req.params.name, pw: r.pw });
});
app.post("/api/rooms", (req, res)=>{
  const { name, pw } = req.body || {};
  if(!name) return res.status(400).json({ message: "이름 필요" });
  if(rooms.has(name)) return res.status(409).json({ message: "중복" });
  rooms.set(name, { pw: pw || "", members: new Set(), history: [], createdAt: Date.now() });
  io.emit("presence:update", { room: name, members: 0, type: "roomCreated" });
  res.json({ ok: true });
});
///api/rooms: 방 전체 목록 반환
///api/rooms/:name: 특정 방 정보 반환 (비밀번호 있는지)
///api/rooms (POST): 새 방 생성

// --- Admin 관련 API---
app.get("/api/admin/users", (_req, res) => {
  const list = Array.from(users.entries()).map(([id, u]) => {
    return { id, pw: u.pw };
  });
  res.json({ users: list });
});
app.get("/api/admin/deleted", (_req, res)=>{
  res.json(deletedRooms);
});
app.get("/api/admin/deleted/:name", (req, res)=>{
  const name = req.params.name;
  const item = deletedRooms.find(r => r.name === name);
  if(!item) return res.status(404).json({ message: "아카이브 없음" });
  res.json(item);
});
app.get("/api/admin/deleted/:name/export", (req, res)=>{
  const name = req.params.name;
  const item = deletedRooms.find(r => r.name === name);
  if(!item) return res.status(404).json({ message: "아카이브 없음" });
  const fname = `${Date.now()}-${name}-archive.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.json(item);
});
///api/admin/users: 현재 등록된 유저와 비밀번호 그대로 반환 (보안상 취약, 데모용)
///api/admin/deleted: 삭제된 방 목록
///api/admin/deleted/:name: 특정 삭제된 방 상세정보
///api/admin/deleted/:name/export: JSON 파일 다운로드
//--- 소켓 이벤트 (실시간 채팅)---
io.on("connection", (socket)=>{
  socket.on("auth", ({ user })=>{
    onlineUsers.set(socket.id, user);
    io.emit("admin:state", getAdminState());
  });

  socket.on("room:join", ({ room, user })=>{
    if(!rooms.has(room)) rooms.set(room, { pw: "", members: new Set(), history: [] });
    socket.join(room);
    rooms.get(room).members.add(user);
    socket.data.user = user;
    socket.data.room = room;
    // send history to new user
    socket.emit("room:joined", { room, members: rooms.get(room).members.size, history: rooms.get(room).history });
    io.to(room).emit("presence:update", { room, members: rooms.get(room).members.size, type: "join", user });
  });

  socket.on("chat:message", ({ room, text, file })=>{
    const user = socket.data.user || "unknown";
    if(!room || !io.sockets.adapter.rooms.get(room)) return;
    const msg = { user, time: Date.now(), text: text||"", file: file || null };
    const r = rooms.get(room);
    if(r){ r.history.push(msg); if(r.history.length>200) r.history.shift(); }
    io.to(room).emit("chat:message", msg);
  });

  socket.on("room:leave", ({ room })=>{
    const user = socket.data.user;
    socket.leave(room);
    const r = rooms.get(room);
    if(r){
      r.members.delete(user);
      const count = r.members.size;
      if(count === 0){
        archiveRoom(room, "last_member_left");
        archiveRoom(room, "disconnect_last_member");
        rooms.delete(room);
        io.emit("presence:update", { room, members: 0, type: "roomDeleted" });
        io.emit("admin:state", getAdminState());
      } else {
        io.to(room).emit("presence:update", { room, members: count, type: "leave", user });
        io.emit("admin:state", getAdminState());
      }
    }
  });

  socket.on("disconnect", ()=>{
    const user = onlineUsers.get(socket.id);
    const room = socket.data.room;
    if(room && rooms.has(room)){
      const r = rooms.get(room);
      r.members.delete(user);
      const count = r.members.size;
      if(count === 0){
        archiveRoom(room, "disconnect_last_member");
        rooms.delete(room);
        io.emit("presence:update", { room, members: 0, type: "roomDeleted" });
      } else {
        io.to(room).emit("presence:update", { room, members: count, type: "leave", user });
      }
    }
    onlineUsers.delete(socket.id);
    io.emit("admin:state", getAdminState());
  });

  // admin
  socket.on("admin:getState", ()=>{
    socket.emit("admin:state", getAdminState());
  });
});
//auth: 유저 로그인 → onlineUsers 등록
//room:join: 방 입장 → 멤버 추가, 히스토리 전달
//chat:message: 메시지 전송 → 해당 방 모든 멤버에게 브로드캐스트
//room:leave: 방 퇴장 → 멤버 감소, 0명이면 방 삭제 + 아카이브 저장
//disconnect: 연결 끊김 처리
//admin:getState: 관리자 화면용 현재 상태 반환

function archiveRoom(name, reason){
  const r = rooms.get(name);
  if(!r) return;
  const archive = {
    name,                                            //방 이름
    pw: r.pw,                                        //방 비밀번호
    createdAt: r.createdAt || null,                  //방이 처음 만들어진 시각
    deletedAt: Date.now(),                           //지금 삭제된 시각(현재시간)
    reason: reason || "unknown",                     //삭제 사유 (leave/disconnect 등)
    membersAtDelete: Array.from(r.members || []),    // 삭제 직전에 남아있던 멤버 목록 
    messageCount: (r.history || []).length,          // 방에 저장된 메시지 개수
    history: (r.history || []).slice(0),             // 방에 남아 있던 메시지 전체 (얕은 복사)
  };
  deletedRooms.push(archive);
}
//방에 아무도 없어서 삭제할 때 호출됨.
//---방 객체(rooms.get(name)) 안에 있던 모든 정보를 꺼내서 archive 라는 객체로 정리.
//그걸 deletedRooms 배열에 넣어서 “삭제된 방 기록”으로 보관.
//즉, 방이 사라져도 기록(누가 있었고, 무슨 메시지가 있었는지) 은 deletedRooms 배열에 남겨둠.
//→ 어드민 화면에서 삭제된 방 아카이브 부분이 이 데이터를 보여줍니다
function getAdminState(){
  return {
    rooms: Array.from(rooms.entries()).map(([name, r])=>({ name, members: r.members.size })),
    users: Array.from(new Set(onlineUsers.values())),
    deletedCount: deletedRooms.length
  };
}
//어드민 모니터링 화면에 보여줄 현재 서버 상태 요약을 반환.


server.listen(PORT, ()=> console.log("Server on http://localhost:"+PORT));
//실제로 HTTP + Socket.IO 서버를 지정된 포트(PORT)에서 실행.
//.env 파일에서 PORT=4000 이라고 설정하면 4000번 포트에서 실행되고, 없으면 3000번이 기본.
//실행하면 콘솔에 Server on http://localhost:3000 출력됨.