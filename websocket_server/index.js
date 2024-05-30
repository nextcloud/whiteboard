import express from 'express'
import http from 'http'
import { Server as SocketIO } from 'socket.io'
import fetch from 'node-fetch'

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

	io.on('connection', async (socket) => {
		let roomDataStore = {};

		const getRoomDataFromFile = async (roomID) => {
			const response = await fetch(`http://nextcloud.local/index.php/apps/whiteboard/${roomID}`, {
				headers: {
					'Authorization': 'Basic ' + Buffer.from('admin:admin').toString('base64')
				}
			});

			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`);
			}

			const data = await response.json();
			const roomData = data.data;

			return JSON.stringify(roomData.elements);
		};

		const convertStringToArrayBuffer = (string) => {
			return new TextEncoder().encode(string).buffer;
		};

		const convertArrayBufferToString = (arrayBuffer) => {
			return new TextDecoder().decode(arrayBuffer);
		};

		const saveRoomDataToFile = async (roomID, data) => {
			console.log(`Saving room data to file: ${roomID}`);

			const body = JSON.stringify({ data: { elements: data }});

			try {
				await fetch(`http://nextcloud.local/index.php/apps/whiteboard/${roomID}`, {
					method: 'PUT',
					headers: {
						'Authorization': 'Basic ' + Buffer.from('admin:admin').toString('base64'),
						'Content-Type': 'application/json'
					},
					body: body,
				});
			} catch (error) {
				console.error(error);
			}
		};

		const saveAllRoomsData = async () => {
			for (const roomID in roomDataStore) {
				const roomData = roomDataStore[roomID];
				await saveRoomDataToFile(roomID, roomData);
			}
		};

		// const interval = setInterval(saveAllRoomsData, 10000);

		io.to(`${socket.id}`).emit('init-room');

		socket.on('join-room', async (roomID) => {
			console.log(`${socket.id} has joined ${roomID}`);
			await socket.join(roomID);

			if (!roomDataStore[roomID]) {
				roomDataStore[roomID] = await getRoomDataFromFile(roomID);
			}

			socket.emit('joined-data', convertStringToArrayBuffer(roomDataStore[roomID]), []);

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
			console.log(`Broadcasting to room ${roomID}`);

			socket.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv);

			const decryptedData = JSON.parse(convertArrayBufferToString(encryptedData));

			setTimeout(() => {
				roomDataStore[roomID] = decryptedData.payload.elements;
			});
		});

		socket.on('server-volatile-broadcast', (roomID, encryptedData, iv) => {
			console.log(`Volatile broadcasting to room ${roomID}`);

			socket.volatile.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv);

			const decryptedData = JSON.parse(convertArrayBufferToString(encryptedData));

			setTimeout(() => {
				roomDataStore[roomID] = decryptedData.payload.elements;
			});
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
				if (roomID === socket.id) continue;

				console.log(`${socket.id} has left ${roomID}`);

				if (roomDataStore[roomID]) {
					await saveRoomDataToFile(roomID, roomDataStore[roomID]);
				}

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

		socket.on('disconnect', async () => {
			socket.removeAllListeners();
			socket.disconnect();
			// clearInterval(interval);
			// await saveAllRoomsData();
			roomDataStore = {};
		});
	});
} catch (error) {
	console.error(error);
}
