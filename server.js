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
const winston = require('winston'); // Winston 모듈 추가
const DailyRotateFile = require('winston-daily-rotate-file'); // 일별 로그 파일 생성을 위한 모듈 추가
const WinstonLoki = require('winston-loki'); // Winston Loki 트랜스포트 추가

// MariaDB 연결 풀 생성
const pool = mariadb.createPool({
  host: '192.168.44.151', // VM1의 MariaDB 서버 IP 주소
  user: 'your_db_user', // MariaDB 사용자 이름
  password: 'your_db_password', // MariaDB 비밀번호
  database: 'your_db_name', // 사용할 데이터베이스 이름
  connectionLimit: 5
});

// Winston 로거 설정
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new DailyRotateFile({
            filename: 'application-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d'
        }),
        // Loki 트랜스포트 추가
        new WinstonLoki({
            host: 'http://192.168.44.154:3100', // VM5의 Loki 서버 주소
            labels: { app: 'company-chat', instance: 'vm2-web' }, // 로그를 식별할 레이블
            jsonStream: true,
            onConnectionError: (err) => console.error('Loki connection error:', err)
        })
    ]
});

// 데이터베이스 스키마 초기화 함수
async function initializeDatabase() {
    let conn;
    try {
        conn = await pool.getConnection();
        const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
        await conn.query(sql);
        logger.info("데이터베이스 스키마 초기화 완료.");
    } catch (err) {
        logger.error(`데이터베이스 초기화 오류: ${err.message}`);
        console.error("Failed to initialize database schema:", err);
    } finally {
        if (conn) conn.release();
    }
}
initializeDatabase();

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
  logger.info(`회원가입 요청: ${id}`); // 로그 추가
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query("INSERT INTO users (username, password_hash) VALUES (?, ?)", [id, pw]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      logger.warn(`회원가입 실패 (중복): ${id}`); // 로그 추가
      return res.status(409).json({ message: "이미 존재하는 아이디입니다." });
    }
    logger.error(`회원가입 오류: ${err.message}`); // 로그 추가
    res.status(500).json({ message: "서버 오류" });
  } finally {
    if (conn) conn.release();
  }
});

// 로그인 API
app.post("/api/login", async (req, res) => {
  const { id, pw } = req.body;
  logger.info(`로그인 요청: ${id}`); // 로그 추가
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query("SELECT * FROM users WHERE username = ? AND password_hash = ?", [id, pw]);
    if (rows.length > 0) {
      logger.info(`로그인 성공: ${id}`); // 로그 추가
      res.json({ ok: true });
    } else {
      logger.warn(`로그인 실패 (ID/PW 불일치): ${id}`); // 로그 추가
      res.status(401).json({ message: "아이디 또는 비밀번호가 잘못되었습니다." });
    }
  } catch (err) {
    logger.error(`로그인 오류: ${err.message}`); // 로그 추가
    res.status(500).json({ message: "서버 오류" });
  } finally {
    if (conn) conn.release();
  }
});

// 파일 업로드 API
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    logger.warn('파일 업로드 실패: 파일 없음'); // 로그 추가
    return res.status(400).send('No file uploaded.');
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  logger.info(`파일 업로드 성공: ${req.file.filename}`); // 로그 추가
  res.json({ url: fileUrl });
});

app.use('/uploads', express.static('uploads'));

// 로그 조회 API (Loki로 대체되므로 기능상 필요 없지만, 기존 구조 유지를 위해 남겨둠)
app.get('/api/admin/logs', (req, res) => {
    const logFilePath = path.join(__dirname, 'application.log');
    if (!fs.existsSync(logFilePath)) {
        return res.status(404).json({ message: '로그 파일이 존재하지 않습니다.' });
    }
    const logContent = fs.readFileSync(logFilePath, 'utf8');
    const logs = logContent.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line));
    res.json(logs);
});

// Socket.IO 로직
io.on('connection', (socket) => {
  logger.info(`A user connected: ${socket.id}`); // 로그 추가

  socket.on('join', async (userId, roomId) => {
    socket.join(roomId);
    socket.userId = userId;
    socket.roomId = roomId;
    logger.info(`사용자 '${userId}'가 '${roomId}' 방에 입장했습니다.`); // 로그 추가

    let conn;
    try {
      conn = await pool.getConnection();
      await conn.query("INSERT INTO room_users (room_id, user_id) VALUES (?, ?)", [roomId, userId]);

      const messages = await conn.query("SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp ASC", [roomId]);
      socket.emit('load_messages', messages);
      io.to(roomId).emit('user_joined', `${userId}님이 입장하셨습니다.`);
    } catch (err) {
      logger.error(`방 입장 오류: ${err.message}`); // 로그 추가
    } finally {
      if (conn) conn.release();
    }
  });

  socket.on('chat_message', async (data) => {
    const { userId, roomId, message, type } = data;
    logger.info(`메시지 수신: (방: ${roomId}, 유저: ${userId})`); // 로그 추가
    let conn;
    try {
      conn = await pool.getConnection();
      await conn.query("INSERT INTO messages (room_id, user_id, message, type) VALUES (?, ?, ?, ?)", [roomId, userId, message, type]);
      io.to(roomId).emit('new_message', data);
    } catch (err) {
      logger.error(`메시지 전송 오류: ${err.message}`); // 로그 추가
    } finally {
      if (conn) conn.release();
    }
  });

  socket.on('disconnect', async () => {
    logger.info(`User disconnected: ${socket.id}`); // 로그 추가
    if (socket.userId && socket.roomId) {
      logger.info(`사용자 '${socket.userId}'가 '${socket.roomId}' 방에서 퇴장했습니다.`); // 로그 추가
      io.to(socket.roomId).emit('user_left', `${socket.userId}님이 퇴장하셨습니다.`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Server running on port ${PORT}`); // 로그 추가
});
