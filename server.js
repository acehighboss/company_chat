const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const mariadb = require('mariadb');

// MariaDB 연결 풀 생성
const pool = mariadb.createPool({
  host: '192.168.44.133', // VM1의 MariaDB 서버 IP 주소
  user: 'user1', // MariaDB 사용자 이름
  password: '1234', // MariaDB 비밀번호
  database: 'company_chat', // 사용할 데이터베이스 이름
  connectionLimit: 5
});

const uploadDir = 'uploads/';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage: storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 회원가입 API
app.post("/api/join", async (req, res) => {
  const { id, pw } = req.body;
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query("INSERT INTO users (username, password_hash) VALUES (?, ?)", [id, pw]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: "이미 존재하는 아이디입니다." });
    }
    console.error("회원가입 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  } finally {
    if (conn) conn.release();
  }
});

// 로그인 API
app.post("/api/login", async (req, res) => {
  const { id, pw } = req.body;
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query("SELECT * FROM users WHERE username = ? AND password_hash = ?", [id, pw]);
    if (rows.length > 0) {
      res.json({ ok: true });
    } else {
      res.status(401).json({ message: "아이디 또는 비밀번호가 잘못되었습니다." });
    }
  } catch (err) {
    console.error("로그인 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  } finally {
    if (conn) conn.release();
  }
});

// 파일 업로드 API
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});

app.use('/uploads', express.static('uploads'));

// Socket.IO 로직
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('join', async (userId, roomId) => {
    socket.join(roomId);
    socket.userId = userId;
    socket.roomId = roomId;

    let conn;
    try {
      conn = await pool.getConnection();
      await conn.query("INSERT INTO room_users (room_id, user_id) VALUES (?, ?)", [roomId, userId]);

      const messages = await conn.query("SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp ASC", [roomId]);
      socket.emit('load_messages', messages);
      io.to(roomId).emit('user_joined', `${userId}님이 입장하셨습니다.`);
    } catch (err) {
      console.error("방 입장 오류:", err);
    } finally {
      if (conn) conn.release();
    }
  });

  socket.on('chat_message', async (data) => {
    const { userId, roomId, message, type } = data;
    let conn;
    try {
      conn = await pool.getConnection();
      await conn.query("INSERT INTO messages (room_id, user_id, message, type) VALUES (?, ?, ?, ?)", [roomId, userId, message, type]);
      io.to(roomId).emit('new_message', data);
    } catch (err) {
      console.error("메시지 전송 오류:", err);
    } finally {
      if (conn) conn.release();
    }
  });

  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.id);
    if (socket.userId && socket.roomId) {
      io.to(socket.roomId).emit('user_left', `${socket.userId}님이 퇴장하셨습니다.`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
