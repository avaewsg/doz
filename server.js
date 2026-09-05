const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const users = {}; // { socketId: { username, coins: 40, trophies: 0 } }
let waitingPlayers = []; // صف انتظار
const activeGames = {}; // بازی‌های فعال

io.on('connection', (socket) => {
    console.log('کاربر متصل شد:', socket.id);

    socket.on('login', (username) => {
        if (!users[socket.id]) {
            users[socket.id] = {
                username: username || `بازیکن_${Math.floor(Math.random() * 1000)}`,
                coins: 40, // شروع با 40 سکه
                trophies: 0
            };
        }
        socket.emit('init_data', users[socket.id]);
    });

    socket.on('find_game', () => {
        const player = users[socket.id];
        if (!player) return;

        if (player.coins < 10) {
            socket.emit('error_msg', 'سکه‌های شما برای ورود کافی نیست (حداقل ۱۰ سکه)');
            return;
        }

        if (waitingPlayers.includes(socket.id)) return;

        player.coins -= 10;
        socket.emit('update_stats', player);

        while (waitingPlayers.length > 0) {
            const opponentId = waitingPlayers.shift();
            
            if (opponentId !== socket.id && users[opponentId] && io.sockets.sockets.has(opponentId)) {
                const roomId = `room_${Date.now()}`;
                
                activeGames[roomId] = {
                    players: [socket.id, opponentId],
                    board: Array(9).fill(null),
                    turn: socket.id // تصادفی یا شروع‌کننده نفر اول
                };

                socket.join(roomId);
                io.sockets.sockets.get(opponentId)?.join(roomId);

                io.to(roomId).emit('game_start', {
                    roomId,
                    players: {
                        [socket.id]: users[socket.id].username,
                        [opponentId]: users[opponentId].username
                    },
                    turn: socket.id
                });
                return;
            }
        }

        waitingPlayers.push(socket.id);
        socket.emit('waiting_for_opponent');
    });

    socket.on('cancel_search', () => {
        const index = waitingPlayers.indexOf(socket.id);
        if (index !== -1) {
            waitingPlayers.splice(index, 1);
            if (users[socket.id]) {
                users[socket.id].coins += 10; // برگشت سکه
                socket.emit('update_stats', users[socket.id]);
            }
            socket.emit('search_cancelled');
        }
    });

    socket.on('make_move', ({ roomId, index }) => {
        const game = activeGames[roomId];
        if (!game || game.turn !== socket.id) return;
        if (game.board[index] !== null) return;

        const symbol = game.players[0] === socket.id ? 'X' : 'O';
        game.board[index] = symbol;

        const winnerSymbol = checkWin(game.board);
        
        if (winnerSymbol || game.board.every(cell => cell !== null)) {
            // پایان بازی یک مرحله‌ای
            let finalWinner = null;
            const p1 = game.players[0];
            const p2 = game.players[1];

            if (winnerSymbol) {
                finalWinner = (winnerSymbol === 'X') ? p1 : p2;
            }

            if (finalWinner) {
                const loser = finalWinner === p1 ? p2 : p1;
                
                users[finalWinner].coins += 80;
                users[finalWinner].trophies += 40;
                users[loser].trophies = Math.max(0, users[loser].trophies - 10);

                io.to(roomId).emit('game_over', {
                    board: game.board,
                    winnerName: users[finalWinner].username,
                    isDraw: false
                });

                io.to(finalWinner).emit('update_stats', users[finalWinner]);
                io.to(loser).emit('update_stats', users[loser]);
            } else {
                // مساوی (برگشت سکه ورودی یا حالت بی‌نصیب)
                io.to(roomId).emit('game_over', {
                    board: game.board,
                    winnerName: 'مساوی!',
                    isDraw: true
                });
            }
            delete activeGames[roomId];
        } else {
            game.turn = game.players.find(id => id !== socket.id);
            io.to(roomId).emit('update_board', { board: game.board, turn: game.turn });
        }
    });

    socket.on('disconnect', () => {
        const index = waitingPlayers.indexOf(socket.id);
        if (index !== -1) waitingPlayers.splice(index, 1);
        delete users[socket.id];
    });
});

function checkWin(b) {
    const lines = [
        [0,1,2], [3,4,5], [6,7,8],
        [0,3,6], [1,4,7], [2,5,8],
        [0,4,8], [2,4,6]
    ];
    for (let l of lines) {
        if (b[l[0]] && b[l[0]] === b[l[1]] && b[l[0]] === b[l[2]]) {
            return b[l[0]];
        }
    }
    return null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`سرور نئونی روی پورت ${PORT} اجرا شد`));
