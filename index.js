const { PeerServer } = require('peer');
const { Server } = require("socket.io");

const io = new Server(3001, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingInterval: 25000, // было 5000
  pingTimeout: 20000,  // было 5000
});

const peerServer = PeerServer({
  port: 3002,
  path: '/peerjs/myapp',
  debug: true
});

// Хранилище комнат и сокетов
const rooms = {};
const userSockets = new Map(); // userId -> socket.id
const peerSockets = new Map(); // peerId -> socket.id

// --- СОСТОЯНИЕ КОМНАТЫ: доска и история чата ---
// Хранится в памяти, чтобы опоздавший или переподключившийся участник получил
// текущую доску и переписку. objects — объекты доски (id -> JSON Fabric.js,
// порядок Map = порядок слоёв), messages — последние сообщения чата.
// Когда все вышли — состояние живёт ещё BOARD_TTL (могут переподключиться).
const boards = new Map(); // roomId -> { objects: Map, messages: [], timer }
const BOARD_TTL = 3 * 60 * 60 * 1000;
const BOARD_MAX_OBJECTS = 5000;
const BOARD_MAX_OBJECT_SIZE = 512 * 1024; // байт JSON на объект
const CHAT_MAX_MESSAGES = 500;
const CHAT_MAX_LENGTH = 2000; // символов в сообщении
const BOARD_OPEN_TIMEOUT = 5000; // мс ждём ответа учеников на «открыть доску»

let messageSeq = 0;
const newMessageId = () => `${Date.now().toString(36)}-${(messageSeq++).toString(36)}`;

const getBoard = (roomId) => {
  let board = boards.get(roomId);
  if (!board) {
    // learnersCanEdit — ученикам можно рисовать (включает учитель)
    board = { objects: new Map(), messages: [], timer: null, learnersCanEdit: false };
    boards.set(roomId, board);
  }
  if (board.timer) {
    clearTimeout(board.timer);
    board.timer = null;
  }
  return board;
};

const scheduleBoardCleanup = (roomId) => {
  const board = boards.get(roomId);
  if (!board || board.timer) return;
  board.timer = setTimeout(() => boards.delete(roomId), BOARD_TTL);
};

// Объект доски: { id: строка до 64 символов, ... } и не слишком большой
const isBoardObject = (obj) => {
  if (!obj || typeof obj !== 'object' || typeof obj.id !== 'string') return false;
  if (!obj.id || obj.id.length > 64) return false;
  try {
    return JSON.stringify(obj).length <= BOARD_MAX_OBJECT_SIZE;
  } catch (e) {
    return false;
  }
};

const asList = (data) => (Array.isArray(data) ? data : [data]);

// Менять доску может учитель (board_admin) или любой, если учитель разрешил.
// Флаг board_admin клиент сообщает сам (board:role) — сокет-сервер не знает
// ролей; это защищает от случайных правок, а не от подделки запроса
const canEditBoard = (socket) => {
  if (!socket.room_id) return false;
  if (socket.board_admin) return true;
  const board = boards.get(socket.room_id);
  return Boolean(board && board.learnersCanEdit);
};

io.on('connection', (socket) => {

  socket.on('join-room', (roomId, peerId, userId, userInfo, isStream, isMuted, callback) => {
    try {
      if (!peerId) {
        if (typeof callback === 'function') callback({ success: false, message: 'peer_is_null' });
        return;
      }

      // userId сравниваем строкой: «8» и 8 — один пользователь (иначе старая
      // запись после F5 не удалялась и давала вторую «свою» плитку)
      const userKey = String(userId);

      // Принудительное отключение старого сокета пользователя (от застревания при F5)
      if (userSockets.has(userKey)) {
        const oldSocketId = userSockets.get(userKey);
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket && oldSocket.id !== socket.id) {
          oldSocket.emit('force-disconnect', { reason: 'Переподключение с новой вкладки' });
          oldSocket.disconnect(true);
        }
      }

      socket.peer_id = peerId;
      socket.room_id = roomId;
      socket.user_id = userId;
      userSockets.set(userKey, socket.id);
      peerSockets.set(peerId, socket.id);

      socket.join(roomId);

      // Вернулись в комнату — доску не удаляем
      if (boards.has(roomId)) getBoard(roomId);

      if (!rooms[roomId]) {
        rooms[roomId] = [];
      } else {
        // Удаляем устаревшую запись пользователя, если она осталась
        // Все прежние записи этого пользователя (их могло остаться несколько)
        const stale = rooms[roomId].filter((u) => String(u.userId) === userKey);
        if (stale.length) {
          rooms[roomId] = rooms[roomId].filter((u) => String(u.userId) !== userKey);
          stale.forEach((u) => socket.broadcast.to(roomId).emit('user-disconnected', u.peerId));
        }
      }

      // Сохраняем участника
      rooms[roomId].push({ peerId, userId, userInfo, isStream, isMuted, socketId: socket.id });

      // Уведомляем комнату (передаем полный объект)
      socket.broadcast.to(roomId).emit('user-connected', {
        peerId,
        userId,
        userInfo,
        isStream,
        isMuted
      });

      if (typeof callback === 'function') callback({ success: true });
    } catch (error) {
      console.error('[Socket] Join Room Error:', error);
      socket.disconnect();
    }
  });

  // --- ИНФОРМАЦИЯ О КОМНАТЕ ---
  socket.on('get-room-info', (callback) => {
    const roomInfo = rooms[socket.room_id] || [];
    if (typeof callback === 'function') callback(roomInfo);
  });

  // --- МЕДИА СОСТОЯНИЯ ---
  socket.on('toggle-video', (data) => {
    if (!socket.room_id || !rooms[socket.room_id]) return;
    const findPeer = rooms[socket.room_id].find((r) => r.peerId === data.peerId);
    if (findPeer) {
      findPeer.isStream = data.isStream;
      socket.broadcast.to(socket.room_id).emit('toggle-video', data);
    }
  });

  socket.on('toggle-audio', (data) => {
    if (!socket.room_id || !rooms[socket.room_id]) return;
    const findPeer = rooms[socket.room_id].find((r) => r.peerId === data.peerId);
    if (findPeer) {
      findPeer.isMuted = data.isMuted;
      socket.broadcast.to(socket.room_id).emit('toggle-audio', data);
    }
  });

  // --- ИНТЕРАКТИВНАЯ ДОСКА (РИСОВАНИЕ В ПРЕДЕЛАХ КОМНАТЫ) ---
  socket.on('startDrawing', (data) => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('startDrawing', data);
  });

  socket.on('drawing', (data) => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('drawing', data);
  });

  socket.on('stopDrawing', () => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('stopDrawing');
  });

  socket.on('insertText', (data) => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('insertText', data);
  });

  socket.on('undoDrawing', () => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('undoDrawing');
  });

  socket.on('redoDrawing', () => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('redoDrawing');
  });

  socket.on('clearDrawing', () => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('clearDrawing');
  });

  // --- ДОСКА НА ОБЪЕКТАХ (Fabric.js) ---
  // Текущая доска комнаты — при открытии и после переподключения
  socket.on('board:get', (callback) => {
    if (typeof callback !== 'function') return;
    // joined: false — сокет ещё не вошёл в комнату (клиент повторит запрос)
    const board = socket.room_id ? boards.get(socket.room_id) : null;
    callback({
      joined: Boolean(socket.room_id),
      objects: board ? [...board.objects.values()] : [],
      learnersCanEdit: Boolean(board && board.learnersCanEdit),
    });
  });

  // Кто я на доске: учитель (может рисовать всегда и управлять доступом)
  socket.on('board:role', (data) => {
    socket.board_admin = Boolean(data && data.canManage);
  });

  // Учитель открывает доску у учеников. Каждый отвечает: открыл / занят
  // заданием (у таких окно задания не трогаем). Кто не ответил за
  // BOARD_OPEN_TIMEOUT — попадает в noResponse (связь, вкладка в фоне)
  socket.on('board:open-for-all', (callback) => {
    if (typeof callback !== 'function') return;
    if (!socket.room_id || !socket.board_admin) {
      callback({ success: false });
      return;
    }

    const roomId = socket.room_id;
    socket.broadcast
      .to(roomId)
      .timeout(BOARD_OPEN_TIMEOUT)
      .emit('board:open', {}, (err, responses) => {
        const list = Array.isArray(responses) ? responses.filter(Boolean) : [];
        const answered = new Set(list.map((r) => String(r.userId)));
        const others = (rooms[roomId] || []).filter((u) => u.socketId !== socket.id);
        callback({
          success: true,
          opened: list.filter((r) => r.status === 'opened'),
          busy: list.filter((r) => r.status === 'busy'),
          noResponse: others
            .filter((u) => !answered.has(String(u.userId)))
            .map((u) => ({ userId: u.userId, userInfo: u.userInfo })),
        });
      });
  });

  // Учитель разрешает / запрещает ученикам рисовать — сообщаем всей комнате
  socket.on('board:set-access', (value, callback) => {
    if (!socket.room_id || !socket.board_admin) {
      if (typeof callback === 'function') callback({ success: false });
      return;
    }
    const board = getBoard(socket.room_id);
    board.learnersCanEdit = Boolean(value);
    io.to(socket.room_id).emit('board:access', { learnersCanEdit: board.learnersCanEdit });
    if (typeof callback === 'function') callback({ success: true, learnersCanEdit: board.learnersCanEdit });
  });

  // Добавить объект(ы). Существующий id заменяется на месте (тот же слой)
  socket.on('board:add', (data) => {
    if (!canEditBoard(socket)) return;
    const board = getBoard(socket.room_id);
    const added = asList(data).filter((obj) => {
      if (!isBoardObject(obj)) return false;
      if (!board.objects.has(obj.id) && board.objects.size >= BOARD_MAX_OBJECTS) return false;
      board.objects.set(obj.id, obj);
      return true;
    });
    if (added.length) socket.broadcast.to(socket.room_id).emit('board:add', added);
  });

  // Изменить объект(ы): перемещение, масштаб, текст. Удалённые не воскрешаем
  socket.on('board:update', (data) => {
    if (!canEditBoard(socket)) return;
    const board = getBoard(socket.room_id);
    const updated = asList(data).filter((obj) => {
      if (!isBoardObject(obj) || !board.objects.has(obj.id)) return false;
      board.objects.set(obj.id, obj);
      return true;
    });
    if (updated.length) socket.broadcast.to(socket.room_id).emit('board:update', updated);
  });

  socket.on('board:remove', (ids) => {
    if (!canEditBoard(socket)) return;
    const board = getBoard(socket.room_id);
    const removed = asList(ids).filter((id) => typeof id === 'string' && board.objects.delete(id));
    if (removed.length) socket.broadcast.to(socket.room_id).emit('board:remove', removed);
  });

  // На задний план (например, картинку под рисунки): меняем порядок слоёв
  socket.on('board:to-back', (ids) => {
    if (!canEditBoard(socket)) return;
    const board = getBoard(socket.room_id);
    const moved = asList(ids).filter((id) => typeof id === 'string' && board.objects.has(id));
    if (!moved.length) return;
    const front = moved.map((id) => [id, board.objects.get(id)]);
    const rest = [...board.objects.entries()].filter(([id]) => !moved.includes(id));
    board.objects = new Map([...front, ...rest]);
    socket.broadcast.to(socket.room_id).emit('board:to-back', moved);
  });

  socket.on('board:clear', () => {
    if (!canEditBoard(socket)) return;
    getBoard(socket.room_id).objects.clear();
    socket.broadcast.to(socket.room_id).emit('board:clear');
  });

  // Черновик: штрих/фигура, которые сейчас рисуют (не сохраняется), и его конец
  socket.on('board:draft', (data) => {
    if (canEditBoard(socket)) socket.broadcast.to(socket.room_id).emit('board:draft', data);
  });

  socket.on('board:draft-end', (id) => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('board:draft-end', id);
  });

  // --- ЧАТ И УЧЕБНЫЕ МАТЕРИАЛЫ ---
  // Сообщение чата: сохраняем в истории комнаты. id и время ставит сервер
  // (часы и часовой пояс отправителя не важны), user_id — из входа в комнату.
  // callback — отправителю: его сообщение с id и временем
  socket.on('message', (data, callback) => {
    if (!socket.room_id || !data || typeof data.message !== 'string') return;
    const text = data.message.trim().slice(0, CHAT_MAX_LENGTH);
    if (!text) return;

    // client_id — id отправителя: по нему клиент сверяет, дошло ли сообщение,
    // и досылает недошедшие после переподключения (без дублей)
    const clientId = typeof data.client_id === 'string' ? data.client_id.slice(0, 64) : undefined;
    const board = getBoard(socket.room_id);
    const existing = clientId && board.messages.find((m) => m.client_id === clientId);
    if (existing) {
      if (typeof callback === 'function') callback(existing);
      return;
    }

    const message = {
      id: newMessageId(),
      client_id: clientId,
      user_id: socket.user_id ?? data.user_id,
      userInfo: data.userInfo,
      message: text,
      sent_at: Date.now(),
    };

    board.messages.push(message);
    if (board.messages.length > CHAT_MAX_MESSAGES) board.messages.shift();

    socket.broadcast.to(socket.room_id).emit('new-message', message);
    if (typeof callback === 'function') callback(message);
  });

  // История чата — при открытии конференции и после переподключения.
  // joined: false — сокет ещё не вошёл в комнату (клиент повторит запрос)
  socket.on('chat:history', (callback) => {
    if (typeof callback !== 'function') return;
    const board = socket.room_id ? boards.get(socket.room_id) : null;
    callback({ joined: Boolean(socket.room_id), messages: board ? board.messages : [] });
  });

  socket.on('open_material', (data) => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('open_material', data);
  });

  socket.on('open_task', (data) => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('open_task', data);
  });

  socket.on('close_task', (data) => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('close_task', data);
  });

  socket.on('start_task', (data) => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('start_task', data);
  });

  socket.on('complete_task', (data) => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('complete_task', data);
  });

  socket.on('start_test', () => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('start_test');
  });

  // --- ОТКЛЮЧЕНИЕ ---
  socket.on('disconnect', () => {
    // Удаляем привязки, только если они всё ещё указывают на ЭТОТ сокет
    if (socket.user_id != null && userSockets.get(String(socket.user_id)) === socket.id) {
      userSockets.delete(String(socket.user_id));
    }
    if (socket.peer_id && peerSockets.get(socket.peer_id) === socket.id) {
      peerSockets.delete(socket.peer_id);
    }

    const roomId = socket.room_id;
    if (!roomId || !socket.peer_id || !rooms[roomId]) return;

    const entry = rooms[roomId].find((u) => u.peerId === socket.peer_id);
    // Если клиент уже переподключился и перезашёл с новым сокетом,
    // запись принадлежит новому сокету — не трогаем её
    if (!entry || entry.socketId !== socket.id) return;

    rooms[roomId] = rooms[roomId].filter((u) => u !== entry);
    socket.broadcast.to(roomId).emit('user-disconnected', socket.peer_id);
    if (rooms[roomId].length === 0) {
      delete rooms[roomId];
      // Доску не удаляем сразу: участники могут переподключиться
      scheduleBoardCleanup(roomId);
    }
  });
});