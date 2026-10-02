const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'quizlive.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to SQLite database.');
        db.run('PRAGMA foreign_keys = ON', (pragmaErr) => {
            if (pragmaErr) {
                console.error('Error enabling foreign keys:', pragmaErr.message);
                return;
            }

            initTables();
        });
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
            creator_id INTEGER,
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
            question_type TEXT NOT NULL DEFAULT 'multiple_choice',
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

            // Migrate existing table: add creator_id if it doesn't exist yet
            db.run(`ALTER TABLE quizzes ADD COLUMN creator_id INTEGER`, () => {});
        }
    });

    db.run(createQuestions, (err) => {
        if (err) {
            console.error('Error creating questions table:', err.message);
        } else {
            console.log('Questions table ready.');

            // Migrate existing table: add question_type if it doesn't exist yet
            db.run(
                `ALTER TABLE questions ADD COLUMN question_type TEXT NOT NULL DEFAULT 'multiple_choice'`,
                () => {}
            );
        }
    });

    const createGameRecords = `
        CREATE TABLE IF NOT EXISTS game_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            quiz_id INTEGER NOT NULL,
            quiz_title_snapshot TEXT,
            pin TEXT NOT NULL,
            creator_id INTEGER,
            total_players INTEGER DEFAULT 0,
            total_questions INTEGER DEFAULT 0,
            started_at DATETIME,
            finished_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            questions_json TEXT
        )
    `;

    // Idempotent column add for databases created before game_records tracked
    // the hosting teacher.
    function ensureGameRecordsCreatorId() {
        db.run(`ALTER TABLE game_records ADD COLUMN creator_id INTEGER`, () => {});
    }

    function migrateGameRecordsTable(done) {
        done = done || (() => {});

        db.get(
            `SELECT sql FROM sqlite_master
            WHERE type = 'table' AND name = 'game_records'`,
            (err, table) => {
                if (err) {
                    console.error('Error checking game_records schema:', err.message);
                    return;
                }

                if (!table) return;

                const hasOldCascade = /FOREIGN KEY\s*\(quiz_id\).*ON DELETE CASCADE/i.test(table.sql);
                const hasTitleSnapshot = /quiz_title_snapshot/i.test(table.sql);
                const hasQuestionsSnapshot = /questions_json/i.test(table.sql);
                const hasCreatorId = /creator_id/i.test(table.sql);

                if (!hasOldCascade && hasTitleSnapshot && hasQuestionsSnapshot && hasCreatorId) {
                    done();
                    return;
                }

                console.log('Migrating game_records table...');

                db.all(`PRAGMA table_info(game_records)`, (infoErr, columns) => {
                    if (infoErr) {
                        console.error('Error reading game_records columns:', infoErr.message);
                        return;
                    }

                    const columnNames = new Set(columns.map((column) => column.name));

                    const questionsColumn = columnNames.has('questions_json')
                        ? 'gr.questions_json'
                        : 'NULL';

                    const titleColumn = columnNames.has('quiz_title_snapshot')
                        ? 'gr.quiz_title_snapshot'
                        : 'NULL';

                    const creatorColumn = columnNames.has('creator_id')
                        ? 'gr.creator_id'
                        : 'NULL';

                    db.run(`PRAGMA foreign_keys = OFF`, (pragmaErr) => {
                        if (pragmaErr) {
                            console.error('Error disabling foreign keys:', pragmaErr.message);
                            return;
                        }

                        db.serialize(() => {
                            db.run(`
                                CREATE TABLE game_records_new (
                                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                                    quiz_id INTEGER NOT NULL,
                                    quiz_title_snapshot TEXT,
                                    pin TEXT NOT NULL,
                                    creator_id INTEGER,
                                    total_players INTEGER DEFAULT 0,
                                    total_questions INTEGER DEFAULT 0,
                                    started_at DATETIME,
                                    finished_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                                    questions_json TEXT
                                )
                            `);

                            db.run(`
                                INSERT INTO game_records_new (
                                    id,
                                    quiz_id,
                                    quiz_title_snapshot,
                                    pin,
                                    creator_id,
                                    total_players,
                                    total_questions,
                                    started_at,
                                    finished_at,
                                    questions_json
                                )
                                SELECT
                                    gr.id,
                                    gr.quiz_id,
                                    COALESCE(${titleColumn}, q.title),
                                    gr.pin,
                                    ${creatorColumn},
                                    gr.total_players,
                                    gr.total_questions,
                                    gr.started_at,
                                    gr.finished_at,
                                    ${questionsColumn}
                                FROM game_records gr
                                LEFT JOIN quizzes q ON q.id = gr.quiz_id
                            `);

                            db.run(`DROP TABLE game_records`);

                            db.run(`ALTER TABLE game_records_new RENAME TO game_records`);

                            db.run(`PRAGMA foreign_keys = ON`, (enableErr) => {
                                if (enableErr) {
                                    console.error('Error re-enabling foreign keys:', enableErr.message);
                                    return;
                                }

                                console.log('game_records migration complete.');
                                done();
                            });
                        });
                    });
                });
            }
        );
    }


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
            return;
        }

        console.log('Game records table ready.');

        migrateGameRecordsTable(() => {
            ensureGameRecordsCreatorId();

            db.run(createGamePlayerResults, (playerErr) => {
                if (playerErr) {
                    console.error('Error creating game_player_results table:', playerErr.message);
                } else {
                    console.log('Game player results table ready.');
                }
            });
        });
    });
}


function insertQuiz(quiz) {
    return new Promise((resolve, reject) => {
        const { title, description, creator_id, questions } = quiz;

        db.run(
            'INSERT INTO quizzes (title, description, creator_id) VALUES (?, ?, ?)',
            [title, description, creator_id ?? null],
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
            INSERT INTO questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option, question_type, time_limit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                q.question_type || 'multiple_choice',
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

function getAllQuizzes(creatorId) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT q.*, COUNT(qs.id) AS questionCount
             FROM quizzes q
             LEFT JOIN questions qs ON qs.quiz_id = q.id
             WHERE q.creator_id = ?
             GROUP BY q.id
             ORDER BY q.created_at DESC`,
            [creatorId],
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
        const { quizId, quizTitle, questions, pin, creatorId, totalPlayers, totalQuestions, players, startedAt } = game;

        db.run(
            `INSERT INTO game_records (
                quiz_id,
                quiz_title_snapshot,
                pin,
                creator_id,
                total_players,
                total_questions,
                started_at,
                finished_at,
                questions_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
            [quizId, quizTitle, pin, creatorId ?? null, totalPlayers, totalQuestions, startedAt, JSON.stringify(questions)],
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

// All completed games owned by one teacher, newest first, joined with their quiz
// title so the statistics page can list them without an extra lookup.
function getGameRecords(creatorId) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT gr.*, COALESCE(gr.quiz_title_snapshot, q.title) AS quiz_title
             FROM game_records gr
             LEFT JOIN quizzes q ON q.id = gr.quiz_id
             WHERE gr.creator_id = ?
             ORDER BY gr.finished_at DESC, gr.id DESC`,
            [creatorId],
            (err, rows) => {
                if (err) { reject(err); } else { resolve(rows); }
            }
        );
    });
}

function getGameRecordById(gameId) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT gr.*, COALESCE(gr.quiz_title_snapshot, q.title) AS quiz_title
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

function deleteGameRecord(gameId) {
    return new Promise((resolve, reject) => {
        db.run(
            'DELETE FROM game_records WHERE id = ?',
            [gameId],
            function (err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ deleted: this.changes > 0 });
                }
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
    deleteGameRecord,
    getGamePlayers
};
