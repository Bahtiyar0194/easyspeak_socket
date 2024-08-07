const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Настройка CORS
app.use(cors({
    origin: 'http://localhost:3000', // Укажите ваш фронтенд домен
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    credentials: true
}));

const io = new Server(server, {
    cors: {
        origin: 'http://localhost:3000', // Укажите ваш фронтенд домен
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type'],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

const peerServer = ExpressPeerServer(server, {
    debug: true
});

app.use('/peerjs/myapp', peerServer);

io.on('connection', (socket) => {
    console.log('a user connected:', socket.id);

    socket.on('join-room', (roomId, userId) => {
        socket.join(roomId);
        socket.to(roomId).emit('user-connected', userId);

        socket.on('disconnect', () => {
            socket.to(roomId).emit('user-disconnected', userId);
        });
    });
});

server.listen(3001, () => {
    console.log('Server is running on port 3001');
});
