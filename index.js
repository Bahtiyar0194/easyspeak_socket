const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Настройка PeerJS сервера, используя существующий HTTP сервер
const peerServer = ExpressPeerServer(server, {
    path: '/app'
});

app.use('/peerjs', peerServer);

app.get('/', (req, res) => {
    res.send('Server is running');
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});