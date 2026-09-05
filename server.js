const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const users = {}; // { socketId: { username, coins: 40, trophies: 0 } }
let waitingPlayers = []; // صف انتظار برای مچ‌میکینگ
const activeGames = {}; // مدیریت اتاق‌های بازی فعال

io.on('connection', (socket) => {
    console.log('کاربر متصل شد:', socket.id);

    // ثبت‌نام یا ورود کاربر با نام
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

    // درخواست ورود به بازی آنلاین (کسر 10 سکه ورودی)
    socket.on('find_game', () => {
        const player = users[socket.id];
        if (!player) return;

        if (player.coins < 10) {
            socket.emit('error_msg', 'سکه‌های شما برای ورود به بازی کافی نیست (حداقل 10 سکه)');
            return;
        }

        // جلوگیری از ورود تکراری به صف
        if (waitingPlayers.includes(socket.id)) return;

        // کسر سکه ورودی
        player.coins -= 10;
        socket.emit('update_stats', player);

        // بررسی اینکه آیا کسی در صف انتظار هست یا خیر
        while (waitingPlayers.length > 0) {
            const opponentId = waitingPlayers.shift();
            
            // چک کردن اینکه حریف هنوز متصل است و خودش نیست
            if (opponentId !== socket.id && users[opponentId] && io.sockets.sockets.has(opponentId)) {
                const roomId = `room_${Date.now()}`;
                
                activeGames[roomId] = {
                    players: [socket.id, opponentId],
                    scores: { [socket.id]: 0, [opponentId]: 0 }, // امتیاز در دو راند
                    currentRound: 1,
                    board: Array(9).fill(null),
                    turn: socket.id // شروع‌کننده راند اول
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
                console.log(`بازی بین ${users[socket.id].username} و ${users[opponentId].username} شروع شد.`);
                return;
            }
        }

        // اگر کسی در صف نبود، این کاربر به صف اضافه می‌شود
        waitingPlayers.push(socket.id);
        socket.emit('waiting_for_opponent');
        console.log(`کاربر ${player.username} رفت تو صف انتظار. تعداد در صف: ${waitingPlayers.length}`);
    });

    // لغو جستجوی حریف
    socket.on('cancel_search', () => {
        const index = waitingPlayers.indexOf(socket.id);
        if (index !== -1) {
            waitingPlayers.splice(index, 1);
            if (users[socket.id]) {
                users[socket.id].coins += 10; // برگشت سکه ورودی
                socket.emit('update_stats', users[socket.id]);
            }
            socket.emit('search_cancelled');
            console.log('جستجو لغو شد و سکه برگشت داده شد.');
        }
    });

    // ثبت حرکت در بازی دوز
    socket.on('make_move', ({ roomId, index }) => {
        const game = activeGames[roomId];
        if (!game || game.turn !== socket.id) return;
        if (game.board[index] !== null) return;

        const symbol = game.players[0] === socket.id ? 'X' : 'O';
        game.board[index] = symbol;

        const winnerSymbol = checkWin(game.board);
        
        if (winnerSymbol || game.board.every(cell => cell !== null)) {
            // پایان راند فعلی
            if (winnerSymbol) {
                const roundWinner = winnerSymbol === 'X' ? game.players[0] : game.players[1];
                game.scores[roundWinner]++;
            }

            // بررسی پایان کل بازی (دو دوز / دو راند)
            if (game.currentRound >= 2 || Math.max(...Object.values(game.scores)) === 2) {
                let finalWinner = null;
                const p1 = game.players[0];
                const p2 = game.players[1];

                if (game.scores[p1] > game.scores[p2]) finalWinner = p1;
                else if (game.scores[p2] > game.scores[p1]) finalWinner = p2;

                if (finalWinner) {
                    const loser = finalWinner === p1 ? p2 : p1;
                    
                    // پاداش 80 سکه و 40 کاپ به برنده
                    users[finalWinner].coins += 80;
                    users[finalWinner].trophies += 40;
                    
                    // کسر 10 کاپ از بازنده
                    users[loser].trophies = Math.max(0, users[loser].trophies - 10);

                    io.to(roomId).emit('game_over_final', {
                        board: game.board,
                        winnerName: users[finalWinner].username,
                        scores: game.scores
                    });

                    io.to(finalWinner).emit('update_stats', users[finalWinner]);
                    io.to(loser).emit('update_stats', users[loser]);
                } else {
                    io.to(roomId).emit('game_over_final', {
                        board: game.board,
                        winnerName: 'مساوی!',
                        scores: game.scores
                    });
                }
                delete activeGames[roomId];
            } else {
                // رفتن به راند دوم
                io.to(roomId).emit('round_over', {
                    board: game.board,
                    scores: game.scores,
                    round: game.currentRound
                });

                game.currentRound++;
                game.board = Array(9).fill(null);
                // تغییر نوبت شروع‌کننده در راند دوم برای تعادل
                game.turn = game.players.find(id => id !== socket.id);
            }
        } else {
            // تغییر نوبت معمولی بین بازیکنان
            game.turn = game.players.find(id => id !== socket.id);
            io.to(roomId).emit('update_board', { board: game.board, turn: game.turn });
        }
    });

    socket.on('disconnect', () => {
        const index = waitingPlayers.indexOf(socket.id);
        if (index !== -1) waitingPlayers.splice(index, 1);
        delete users[socket.id];
        console.log('کاربر قطع شد:', socket.id);
    });
});

function checkWin(b) {
    const lines = [
        [0,1,2], [3,4,5], [6,7,8], // افقی
        [0,3,6], [1,4,7], [2,5,8], // عمودی
        [0,4,8], [2,4,6]           // اریب
    ];
    for (let l of lines) {
        if (b[l[0]] && b[l[0]] === b[l[1]] && b[l[0]] === b[l[2]]) {
            return b[l[0]];
        }
    }
    return null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`سرور روی پورت ${PORT} اجرا شد`));
