import express from 'express';
import http from 'http';
import {Server as SocketIO} from 'socket.io';
import axios from 'axios';

const app = express();

const port = process.env.PORT || 3002;

app.get('/', (req, res) => {
	res.send('Excalidraw collaboration server is up :)');
});

const server = http.createServer(app);

server.listen(port, () => {
	console.log(`listening on port: ${port}`);
});

try {
	const io = new SocketIO(server, {
		transports: ['websocket', 'polling'], cors: {
			allowedHeaders: ['X-Requested-With', 'Content-Type', 'Authorization'],
			origin: '*',
			methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
		}, allowEIO3: true,
	});

	io.on('connection', (socket) => {
		console.log('connection established!');
		io.to(`${socket.id}`).emit('init-room');

		socket.on('join-room', async (roomID) => {
			console.log(`${socket.id} has joined ${roomID}`);
			await socket.join(roomID);

			// Fetch data from the PHP service API
			try {
				const response = await axios.get(`http://nextcloud.local/index.php/apps/whiteboard/${roomID}`, {
					auth: {
						username: 'admin', password: 'admin'
					}
				});
				const roomData = response.data.data;

				// Convert the room data to a JSON string
				const jsonString = JSON.stringify(roomData.elements);

				// Use the TextEncoder API to convert the JSON string to a Uint8Array
				const uint8Array = new TextEncoder().encode(jsonString);

				// Get the ArrayBuffer from the Uint8Array
				const arrayBuffer = uint8Array.buffer;

				socket.emit('joined-data', arrayBuffer, []);
			} catch (error) {
				console.error(`Failed to fetch data for room ${roomID}`, error);
			}

			const sockets = await io.in(roomID).fetchSockets();
			if (sockets.length <= 1) {
				io.to(`${socket.id}`).emit('first-in-room');
			} else {
				console.log(`${socket.id} new-user emitted to room ${roomID}`);
				socket.broadcast.to(roomID).emit('new-user', socket.id);
			}

			io.in(roomID).emit('room-user-change', sockets.map((socket) => socket.id));
		});

		socket.on('server-broadcast', (roomID, encryptedData, iv) => {
			socket.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv);
		});

		socket.on('server-volatile-broadcast', (roomID, encryptedData, iv) => {
			socket.volatile.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv);
		});

		socket.on('user-follow', async (payload) => {
			console.log(`User follow action: ${JSON.stringify(payload)}`);
			const roomID = `follow@${payload.userToFollow.socketId}`;

			switch (payload.action) {
				case 'FOLLOW': {
					await socket.join(roomID);

					const sockets = await io.in(roomID).fetchSockets();
					const followedBy = sockets.map((socket) => socket.id);

					io.to(payload.userToFollow.socketId).emit('user-follow-room-change', followedBy);

					break;
				}
				case 'UNFOLLOW': {
					await socket.leave(roomID);

					const sockets = await io.in(roomID).fetchSockets();
					const followedBy = sockets.map((socket) => socket.id);

					io.to(payload.userToFollow.socketId).emit('user-follow-room-change', followedBy);

					break;
				}
			}
		});

		socket.on('disconnecting', async () => {
			console.log(`${socket.id} has disconnected`);
			for (const roomID of Array.from(socket.rooms)) {
				const otherClients = (await io.in(roomID).fetchSockets()).filter((_socket) => _socket.id !== socket.id);

				const isFollowRoom = roomID.startsWith('follow@');

				if (!isFollowRoom && otherClients.length > 0) {
					socket.broadcast.to(roomID).emit('room-user-change', otherClients.map((socket) => socket.id));
				}

				if (isFollowRoom && otherClients.length === 0) {
					const socketId = roomID.replace('follow@', '');
					io.to(socketId).emit('broadcast-unfollow');
				}
			}
		});

		socket.on('disconnect', () => {
			socket.removeAllListeners();
			socket.disconnect();
		});
	});
} catch (error) {
	console.error(error);
}
