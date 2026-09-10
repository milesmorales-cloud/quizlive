const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'quizlive.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to SQLite database.');
        initTables();
    }
});

function initTables() {
    const createUsers = `
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'teacher',
            security_question TEXT,
            security_answer TEXT
        )
    `;

    const createQuizzes = `
        CREATE TABLE IF NOT EXISTS quizzes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `;

    const createQuestions = `
        CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            quiz_id INTEGER NOT NULL,
            question_text TEXT NOT NULL,
            option_a TEXT NOT NULL,
            option_b TEXT NOT NULL,
            option_c TEXT,
            option_d TEXT,
            correct_option TEXT NOT NULL CHECK(correct_option IN ('A', 'B', 'C', 'D')),
            time_limit INTEGER DEFAULT 30,
            FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
        )
    `;

    db.run(createUsers, (err) => {
        if (err) {
            console.error('Error creating users table:', err.message);
        } else {
            console.log('Users table ready.');
            // Migrate existing table: add security columns if they don't exist yet
            db.run(`ALTER TABLE users ADD COLUMN security_question TEXT`, () => {});
            db.run(`ALTER TABLE users ADD COLUMN security_answer TEXT`, () => {});
        }
    });

    db.run(createQuizzes, (err) => {
        if (err) {
            console.error('Error creating quizzes table:', err.message);
        } else {
            console.log('Quizzes table ready.');
        }
    });

    db.run(createQuestions, (err) => {
        if (err) {
            console.error('Error creating questions table:', err.message);
        } else {
            console.log('Questions table ready.');
        }
    });

    const createGameRecords = `
        CREATE TABLE IF NOT EXISTS game_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            quiz_id INTEGER NOT NULL,
            pin TEXT NOT NULL,
            total_players INTEGER DEFAULT 0,
            total_questions INTEGER DEFAULT 0,
            started_at DATETIME,
            finished_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
        )
    `;

    const createGamePlayerResults = `
        CREATE TABLE IF NOT EXISTS game_player_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            score INTEGER DEFAULT 0,
            answers_json TEXT,
            FOREIGN KEY (game_id) REFERENCES game_records(id) ON DELETE CASCADE
        )
    `;

    db.run(createGameRecords, (err) => {
        if (err) {
            console.error('Error creating game_records table:', err.message);
        } else {
            console.log('Game records table ready.');
        }
    });

    db.run(createGamePlayerResults, (err) => {
        if (err) {
            console.error('Error creating game_player_results table:', err.message);
        } else {
            console.log('Game player results table ready.');
        }
    });
}

function insertQuiz(quiz) {
    return new Promise((resolve, reject) => {
        const { title, description, questions } = quiz;

        db.run(
            'INSERT INTO quizzes (title, description) VALUES (?, ?)',
            [title, description],
            function (err) {
                if (err) {
                    reject(err);
                    return;
                }

                const quizId = this.lastID;
                insertQuestions(quizId, questions)
                    .then(() => resolve({ id: quizId, title }))
                    .catch(reject);
            }
        );
    });
}

function insertQuestions(quizId, questions) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT INTO questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option, time_limit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let completed = 0;
        const total = questions.length;

        if (total === 0) {
            resolve();
            return;
        }

        questions.forEach((q) => {
            stmt.run(
                quizId,
                q.question_text,
                q.option_a,
                q.option_b,
                q.option_c || null,
                q.option_d || null,
                q.correct_option,
                q.time_limit || 30,
                (err) => {
                    if (err) {
                        stmt.finalize();
                        reject(err);
                        return;
                    }

                    completed++;
                    if (completed === total) {
                        stmt.finalize();
                        resolve();
                    }
                }
            );
        });
    });
}

function getAllQuizzes() {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT q.*, COUNT(qs.id) AS questionCount
             FROM quizzes q
             LEFT JOIN questions qs ON qs.quiz_id = q.id
             GROUP BY q.id
             ORDER BY q.created_at DESC`,
            [],
            (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            }
        );
    });
}

function getQuizById(quizId) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT * FROM quizzes WHERE id = ?',
            [quizId],
            (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            }
        );
    });
}

function getQuestionsByQuizId(quizId) {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT * FROM questions WHERE quiz_id = ? ORDER BY id ASC',
            [quizId],
            (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            }
        );
    });
}

function createUser(username, hashedPassword, securityQuestion, securityAnswer) {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO users (username, password, security_question, security_answer) VALUES (?, ?, ?, ?)',
            [username, hashedPassword, securityQuestion, securityAnswer],
            function (err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id: this.lastID, username });
                }
            }
        );
    });
}

function getUserByUsername(username) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT * FROM users WHERE username = ?',
            [username],
            (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            }
        );
    });
}

function updateUserPassword(username, hashedPassword) {
    return new Promise((resolve, reject) => {
        db.run(
            'UPDATE users SET password = ? WHERE username = ?',
            [hashedPassword, username],
            function (err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ changes: this.changes });
                }
            }
        );
    });
}

function deleteQuiz(quizId) {
    return new Promise((resolve, reject) => {
        // Delete questions first (cascade), then the quiz row
        db.run('DELETE FROM questions WHERE quiz_id = ?', [quizId], (err) => {
            if (err) { reject(err); return; }
            db.run('DELETE FROM quizzes WHERE id = ?', [quizId], function (err2) {
                if (err2) { reject(err2); return; }
                resolve({ changes: this.changes });
            });
        });
    });
}

function deleteQuestion(questionId) {
    return new Promise((resolve, reject) => {
        db.run('DELETE FROM questions WHERE id = ?', [questionId], function (err) {
            if (err) { reject(err); return; }
            resolve(this.changes > 0 ? { changes: this.changes } : null);
        });
    });
}

function updateQuizQuestions(quizId, title, questions) {
    return new Promise((resolve, reject) => {
        // Update the title
        db.run('UPDATE quizzes SET title = ? WHERE id = ?', [title, quizId], (err) => {
            if (err) { reject(err); return; }
            // Wipe old questions
            db.run('DELETE FROM questions WHERE quiz_id = ?', [quizId], (err2) => {
                if (err2) { reject(err2); return; }
                // Batch insert new questions
                insertQuestions(quizId, questions)
                    .then(() => resolve({ id: quizId, title }))
                    .catch(reject);
            });
        });
    });
}

// ------------------------------------------------------------
// Game statistics persistence
// ------------------------------------------------------------

// Persist a finished game: one row in game_records plus one row in
// game_player_results per student, holding their full per-question answer
// history (used by the teacher statistics/export views).
function insertGameRecord(game) {
    return new Promise((resolve, reject) => {
        const { quizId, pin, totalPlayers, totalQuestions, players, startedAt } = game;

        db.run(
            `INSERT INTO game_records (quiz_id, pin, total_players, total_questions, started_at, finished_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [quizId, pin, totalPlayers, totalQuestions, startedAt],
            function (err) {
                if (err) { reject(err); return; }

                const gameId = this.lastID;
                insertGamePlayerResults(gameId, players)
                    .then(() => resolve({ id: gameId }))
                    .catch(reject);
            }
        );
    });
}

function insertGamePlayerResults(gameId, players) {
    return new Promise((resolve, reject) => {
        const nonHost = players.filter((p) => !p.isHost);
        if (nonHost.length === 0) { resolve(); return; }

        const stmt = db.prepare(
            `INSERT INTO game_player_results (game_id, username, score, answers_json)
             VALUES (?, ?, ?, ?)`
        );

        let completed = 0;
        nonHost.forEach((p) => {
            stmt.run(gameId, p.username, p.score, JSON.stringify(p.answers || []), (err) => {
                if (err) { stmt.finalize(); reject(err); return; }
                completed++;
                if (completed === nonHost.length) {
                    stmt.finalize();
                    resolve();
                }
            });
        });
    });
}

// All completed games, newest first, joined with their quiz title so the
// statistics page can list them without an extra lookup.
function getGameRecords() {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT gr.*, q.title AS quiz_title
             FROM game_records gr
             LEFT JOIN quizzes q ON q.id = gr.quiz_id
             ORDER BY gr.finished_at DESC, gr.id DESC`,
            [],
            (err, rows) => {
                if (err) { reject(err); } else { resolve(rows); }
            }
        );
    });
}

function getGameRecordById(gameId) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT gr.*, q.title AS quiz_title
             FROM game_records gr
             LEFT JOIN quizzes q ON q.id = gr.quiz_id
             WHERE gr.id = ?`,
            [gameId],
            (err, row) => {
                if (err) { reject(err); } else { resolve(row); }
            }
        );
    });
}

function getGamePlayers(gameId) {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT username, score, answers_json FROM game_player_results WHERE game_id = ? ORDER BY score DESC',
            [gameId],
            (err, rows) => {
                if (err) { reject(err); } else { resolve(rows); }
            }
        );
    });
}

module.exports = {
    db,
    createUser,
    getUserByUsername,
    updateUserPassword,
    insertQuiz,
    getAllQuizzes,
    getQuizById,
    getQuestionsByQuizId,
    updateQuizQuestions,
    deleteQuiz,
    deleteQuestion,
    insertGameRecord,
    getGameRecords,
    getGameRecordById,
    getGamePlayers
};
