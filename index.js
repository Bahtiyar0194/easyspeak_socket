const { PeerServer } = require('peer');
const { Server } = require("socket.io");

const io = new Server(3001, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const peerServer = PeerServer({
    port: 3002,
    path: '/peerjs/myapp',
    debug: true
});

const rooms = {};

io.on('connection', (socket) => {
    socket.on('join-room', (roomId, peerId, userInfo) => {
        socket.peer_id = peerId;
        socket.room_id = roomId;

        try {
            socket.join(roomId);

            if (!rooms[roomId]) {
                rooms[roomId] = [];
            }

            rooms[roomId].push({ peerId, userInfo });

            socket.broadcast.to(roomId).emit('user-connected', userInfo);

            socket.on('get-room-info', (callback) => {
                const roomInfo = rooms[roomId] || [];
                callback(roomInfo);
            });

            socket.on('message', (data) => {
                socket.broadcast.to(roomId).emit('new-message', data);
            });

            socket.on('microphone-volume', (data) => {
                socket.broadcast.to(roomId).emit('update-volume', data);
            });

        } catch (error) {
            console.error(`Error in join-room: ${error.message}`);
            socket.disconnect();
        }
    });

    socket.on('disconnect', () => {
        if (socket.room_id && socket.peer_id) {

            rooms[socket.room_id] = rooms[socket.room_id].filter(user => user.peerId !== socket.peer_id);

            socket.broadcast.to(socket.room_id).emit('user-disconnected', socket.peer_id);

            if (rooms[socket.room_id].length === 0) {
                delete rooms[socket.room_id];
            }

            socket.leave(socket.room_id);
        }
    });
});