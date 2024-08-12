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

let clients = [];

io.on('connection', (socket) => {
    clients.push(socket);
    console.log('Client connected, total:', clients.length);

    let user_id;
    let room_id;

    socket.on('join-room', (roomId, userId, userName) => {
        user_id = userId;
        room_id = roomId;

        try {
            socket.join(roomId);
            socket.broadcast.to(roomId).emit('user-connected', userId, userName);
            console.log('User connected:', userName);

            socket.on('message', (data) => {
                console.log('Message to room:', roomId);
                socket.broadcast.to(roomId).emit('new-message', data);
            });

        } catch (error) {
            console.error('Error during join-room:', error);
            socket.disconnect();
        }
    });

    socket.on('disconnect', (reason) => {
        console.log('User disconnected:', user_id, 'Reason:', reason);

        if (room_id && user_id) {
            socket.broadcast.to(room_id).emit('user-disconnected', user_id);
        }

        const i = clients.indexOf(socket);
        if (i !== -1) {
            clients.splice(i, 1);
        }
        console.log('Client disconnected, total:', clients.length);
    });
});