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

io.on('connection', (socket) => {
    socket.on('join-room', (roomId, userId) => {
        console.log(userId + ' connected');
        socket.join(roomId);
        socket.broadcast.to(roomId).emit('user-connected', userId);
    });

    socket.on('user-disconnect', (roomId, userId) => {
        console.log(userId + ' disconnected')
        socket.broadcast.to(roomId).emit('user-disconnected', userId);
    });

    socket.on('message', (roomId, data) => {
        socket.broadcast.to(roomId).emit('new-message', data)
    });
});