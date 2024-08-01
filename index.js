const { PeerServer } = require('peer');
const { Server } = require("socket.io");

const io = new Server(3001, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const peerServer = PeerServer({ port: 9000, path: '/peerjs' });

io.on('connection', (socket) => {
    console.log('New client connected');

    socket.on('join-room', (roomId, userId) => {
        socket.join(roomId);
        socket.broadcast.to(roomId).emit('user-connected', userId);

        socket.on('message', (roomId, data) => {
            socket.broadcast.to(roomId).emit('new-message', data);
        });

        socket.on('disconnect', () => {
            socket.broadcast.to(roomId).emit('user-disconnected', userId);
        });
    });
});