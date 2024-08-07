const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const peerServer = ExpressPeerServer(server, {
    debug: true,
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