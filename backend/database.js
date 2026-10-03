require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
});

async function insertQuiz(quiz) {
    const client = await pool.connect();

    try {
        const { title, description, creator_id, questions } = quiz;

        await client.query('BEGIN');

        const result = await client.query(
            'INSERT INTO quizzes (title, description, creator_id) VALUES ($1, $2, $3) RETURNING id',
            [title, description, creator_id ?? null]
        );

        const quizId = result.rows[0].id;

        await insertQuestions(client, quizId, questions);

        await client.query('COMMIT');

        return { id: quizId, title };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function insertQuestions(client, quizId, questions) {
    if (questions.length === 0) {
        return;
    }

    for (const q of questions) {
        await client.query(
            `INSERT INTO questions (
                quiz_id,
                question_text,
                option_a,
                option_b,
                option_c,
                option_d,
                correct_option,
                question_type,
                time_limit
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                quizId,
                q.question_text,
                q.option_a,
                q.option_b,
                q.option_c || null,
                q.option_d || null,
                q.correct_option,
                q.question_type || 'multiple_choice',
                q.time_limit || 30
            ]
        );
    }
}

function getAllQuizzes(creatorId) {
    return new Promise((resolve, reject) => {
        pool.query(
            `SELECT q.*, COUNT(qs.id)::int AS "questionCount"
             FROM quizzes q
             LEFT JOIN questions qs ON qs.quiz_id = q.id
             WHERE q.creator_id = $1
             GROUP BY q.id
             ORDER BY q.created_at DESC`,
            [creatorId],
            (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result.rows);
                }
            }
        );
    });
}

function getQuizById(quizId) {
    return new Promise((resolve, reject) => {
        pool.query(
            'SELECT * FROM quizzes WHERE id = $1',
            [quizId],
            (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result.rows[0]);
                }
            }
        );
    });
}

function getQuestionsByQuizId(quizId) {
    return new Promise((resolve, reject) => {
        pool.query(
            'SELECT * FROM questions WHERE quiz_id = $1 ORDER BY id ASC',
            [quizId],
            (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result.rows);
                }
            }
        );
    });
}

function createUser(username, hashedPassword, securityQuestion, securityAnswer) {
    return new Promise((resolve, reject) => {
        pool.query(
            `INSERT INTO users (
                username,
                password,
                security_question,
                security_answer
            )
            VALUES ($1, $2, $3, $4)
            RETURNING id`,
            [username, hashedPassword, securityQuestion, securityAnswer],
            (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id: result.rows[0].id, username });
                }
            }
        );
    });
}

function getUserByUsername(username) {
    return new Promise((resolve, reject) => {
        pool.query(
            'SELECT * FROM users WHERE username = $1',
            [username],
            (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result.rows[0]);
                }
            }
        );
    });
}

function updateUserPassword(username, hashedPassword) {
    return new Promise((resolve, reject) => {
        pool.query(
            'UPDATE users SET password = $1 WHERE username = $2',
            [hashedPassword, username],
            (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve({ changes: result.rowCount });
                }
            }
        );
    });
}

function deleteQuiz(quizId) {
    return new Promise((resolve, reject) => {
        // Delete questions first (cascade), then the quiz row
        pool.query('DELETE FROM questions WHERE quiz_id = $1', [quizId], (err) => {
            if (err) { reject(err); return; }
            pool.query('DELETE FROM quizzes WHERE id = $1', [quizId], function (err2, result2) {
                if (err2) { reject(err2); return; }
                resolve({ changes: result2.rowCount });
            });
        });
    });
}

function deleteQuestion(questionId) {
    return new Promise((resolve, reject) => {
        pool.query(
            'DELETE FROM questions WHERE id = $1',
            [questionId],
            (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(
                        result.rowCount > 0
                            ? { changes: result.rowCount }
                            : null
                    );
                }
            }
        );
    });
}

async function updateQuizQuestions(quizId, title, questions) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Update the quiz title
        await client.query(
            'UPDATE quizzes SET title = $1 WHERE id = $2',
            [title, quizId]
        );

        // Remove the old questions
        await client.query(
            'DELETE FROM questions WHERE quiz_id = $1',
            [quizId]
        );

        // Insert the new questions using the same transaction connection
        await insertQuestions(client, quizId, questions);

        await client.query('COMMIT');

        return { id: quizId, title };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ------------------------------------------------------------
// Game statistics persistence
// ------------------------------------------------------------

// Persist a finished game: one row in game_records plus one row in
// game_player_results per student, holding their full per-question answer
// history (used by the teacher statistics/export views).
async function insertGameRecord(game) {
    const client = await pool.connect();

    try {
        const {
            quizId,
            quizTitle,
            questions,
            pin,
            creatorId,
            totalPlayers,
            totalQuestions,
            players,
            startedAt
        } = game;

        await client.query('BEGIN');

        const result = await client.query(
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
            VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, $8)
            RETURNING id`,
            [
                quizId,
                quizTitle,
                pin,
                creatorId ?? null,
                totalPlayers,
                totalQuestions,
                startedAt,
                JSON.stringify(questions)
            ]
        );

        const gameId = result.rows[0].id;

        await insertGamePlayerResults(client, gameId, players);

        await client.query('COMMIT');

        return { id: gameId };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function insertGamePlayerResults(client, gameId, players) {
    const nonHost = players.filter((p) => !p.isHost);

    if (nonHost.length === 0) {
        return;
    }

    for (const p of nonHost) {
        await client.query(
            `INSERT INTO game_player_results (
                game_id,
                username,
                score,
                answers_json
            )
            VALUES ($1, $2, $3, $4)`,
            [
                gameId,
                p.username,
                p.score,
                JSON.stringify(p.answers || [])
            ]
        );
    }
}

// All completed games owned by one teacher, newest first, joined with their quiz
// title so the statistics page can list them without an extra lookup.
function getGameRecords(creatorId) {
    return new Promise((resolve, reject) => {
        pool.query(
            `SELECT gr.*, COALESCE(gr.quiz_title_snapshot, q.title) AS quiz_title
             FROM game_records gr
             LEFT JOIN quizzes q ON q.id = gr.quiz_id
             WHERE gr.creator_id = $1
             ORDER BY gr.finished_at DESC, gr.id DESC`,
            [creatorId],
            (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result.rows);
                }
            }
        );
    });
}

function getGameRecordById(gameId) {
    return new Promise((resolve, reject) => {
        pool.query(
            `SELECT gr.*, COALESCE(gr.quiz_title_snapshot, q.title) AS quiz_title
             FROM game_records gr
             LEFT JOIN quizzes q ON q.id = gr.quiz_id
             WHERE gr.id = $1`,
            [gameId],
            (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result.rows[0]);
                }
            }
        );
    });
}

function deleteGameRecord(gameId) {
    return new Promise((resolve, reject) => {
        pool.query(
            'DELETE FROM game_records WHERE id = $1',
            [gameId],
            (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve({ deleted: result.rowCount > 0 });
                }
            }
        );
    });
}

function getGamePlayers(gameId) {
    return new Promise((resolve, reject) => {
        pool.query(
            'SELECT username, score, answers_json FROM game_player_results WHERE game_id = $1 ORDER BY score DESC',
            [gameId],
            (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result.rows);
                 }
            }
        );
    });
}

module.exports = {
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
