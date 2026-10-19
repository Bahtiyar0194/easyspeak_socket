const { PeerServer } = require('peer');
const { Server } = require("socket.io");

const io = new Server(3001, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 5000,
  pingInterval: 5000
});

const peerServer = PeerServer({
  port: 3002,
  path: '/peerjs/myapp',
  debug: true
});

// Хранилище комнат и сокетов
const rooms = {};
const userSockets = new Map(); // userId -> socket.id

io.on('connection', (socket) => {

  socket.on('join-room', (roomId, peerId, userId, userInfo, isStream, isMuted, callback) => {
    try {
      if (!peerId) {
        if (typeof callback === 'function') callback({ success: false, message: 'peer_is_null' });
        return;
      }

      // Принудительное отключение старого сокета пользователя (от застревания при F5)
      if (userSockets.has(userId)) {
        const oldSocketId = userSockets.get(userId);
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket && oldSocket.id !== socket.id) {
          oldSocket.emit('force-disconnect', { reason: 'Переподключение с новой вкладки' });
          oldSocket.disconnect(true);
        }
      }

      socket.peer_id = peerId;
      socket.room_id = roomId;
      socket.user_id = userId;
      userSockets.set(userId, socket.id);

      socket.join(roomId);

      if (!rooms[roomId]) {
        rooms[roomId] = [];
      } else {
        // Удаляем устаревшую запись пользователя, если она осталась
        const existingUser = rooms[roomId].find((u) => u.userId === userId);
        if (existingUser) {
          rooms[roomId] = rooms[roomId].filter(user => user.userId !== userId);
          socket.broadcast.to(roomId).emit('user-disconnected', existingUser.peerId);
        }
      }

      // Сохраняем участника
      rooms[roomId].push({ peerId, userId, userInfo, isStream, isMuted });

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

  // --- ЧАТ И УЧЕБНЫЕ МАТЕРИАЛЫ ---
  socket.on('message', (data) => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('new-message', data);
  });

  socket.on('microphone-volume', (data) => {
    if (socket.room_id) socket.broadcast.to(socket.room_id).emit('update-volume', data);
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
    if (socket.user_id && userSockets.get(socket.user_id) === socket.id) {
      userSockets.delete(socket.user_id);
    }

    if (socket.room_id && socket.peer_id && rooms[socket.room_id]) {
      rooms[socket.room_id] = rooms[socket.room_id].filter(user => user.peerId !== socket.peer_id);

      socket.broadcast.to(socket.room_id).emit('user-disconnected', socket.peer_id);

      if (rooms[socket.room_id].length === 0) {
        delete rooms[socket.room_id];
      }

      socket.leave(socket.room_id);
    }
  });
});