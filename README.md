# 🎯 QuizLive

> A real-time multiplayer quiz platform for live classroom learning.

QuizLive is a web-based quiz platform designed for interactive classroom sessions.
A host creates and launches a quiz, students join using a session PIN, and everyone
participates in real time.

The platform combines a traditional REST API with Socket.IO to handle live game
state, question delivery, timers, answers, scoring, and leaderboard updates.

---

## ✨ Features

### 🧑‍🏫 Host

- Create and manage quizzes
- Launch live quiz sessions
- Generate a unique session PIN
- Monitor players joining the lobby
- Start and control live quiz sessions
- View live game progress
- Reveal final results
- View the final leaderboard

### 👨‍🎓 Players

- Join a quiz using a session PIN
- Enter a username without requiring a full account for the live session
- Receive questions in real time
- Answer within the configured time limit
- Receive points based on correctness and response speed
- View live progress and final results
- Reconnect to an active session after page navigation or socket reconnection

### ⚡ Real-Time Gameplay

- Live question broadcasting
- Per-question countdown timer
- Real-time answer submission
- Automatic question progression
- Live leaderboard updates
- Player reconnection
- Host session recovery

---

## 🏗️ Architecture

```text
                    ┌─────────────────────┐
                    │      Browser        │
                    │                     │
                    │  Host / Player UI   │
                    └──────────┬──────────┘
                               │
                 HTTP REST     │     WebSocket
                               │     Socket.IO
                               ▼
                    ┌─────────────────────┐
                    │    Express Server   │
                    │                     │
                    │  REST API           │
                    │  Game Logic         │
                    │  Session Management │
                    │  Scoring            │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │       SQLite        │
                    │                     │
                    │ Users               │
                    │ Quizzes             │
                    │ Questions           │
                    │ Game Records        │
                    │ Player Results      │
                    └─────────────────────┘
### Communication

REST API is used for normal application operations such as authentication
and quiz-related data.

Socket.IO handles the live multiplayer game:

Lobby updates
Game start
Question delivery
Timers
Answer submission
Leaderboard updates
Game completion
Session recovery


🚀 Getting Started
Prerequisites

Make sure you have:

Node.js
npm
Git
1. Clone the repository
git clone https://github.com/milesmorales-cloud/quizlive.git
cd quizlive
2. Install backend dependencies
cd backend
npm ci
3. Start the server
npm start

The server runs on:

http://localhost:3000

🎮 How a Game Works
1. Create a Quiz

The host creates a quiz and adds questions with their answer options.

2. Create a Lobby

The host launches a live session and receives a unique PIN.

3. Players Join

Players enter the PIN and their username to join the lobby.

4. Start the Game

The host starts the session.

QuizLive then uses Socket.IO to distribute the live game state.

5. Answer Questions

Players receive each question together with a countdown timer.

Answers are submitted through the real-time connection.

6. Scoring

The server evaluates answers and updates each player's score.

Faster correct answers can earn more points than answers submitted later.

7. Leaderboard

The leaderboard is updated throughout the session.

8. Results

When the final question is completed, the host can reveal the final results
and leaderboard.

🔄 Session Recovery

QuizLive includes session recovery for both players and hosts.

Player Reconnection

A player's session state can be recovered when their browser navigates to a new
page and establishes a new Socket.IO connection.

The server preserves information such as:

Username
Score
Previous answers
Question state
Answer shuffling state
Host Recovery

The host can reclaim an active session after normal browser navigation causes
the previous Socket.IO connection to close.

A short grace period prevents the lobby from being destroyed immediately while
the host reconnects.

🔐 Authentication

QuizLive includes user authentication functionality for application accounts.

Passwords are handled using bcrypt rather than being stored as plain text.

Input validation is performed on authentication-related requests.

🧪 Testing

The application can be tested using:

Browser-based end-to-end testing
Postman for REST API testing
Multiple browser/device sessions for multiplayer testing

A typical multiplayer test involves:

Host Browser
     │
     ├── Create quiz
     ├── Start lobby
     │
     ▼
Socket.IO Server
     │
     ├──────────────┐
     ▼              ▼
Player 1        Player 2
     │              │
     └──── Answers ─┘
            │
            ▼
       Live Scoring
            │
            ▼
       Leaderboard
🧠 Key Engineering Concepts

This project demonstrates practical experience with:

REST API design
Client-server architecture
WebSocket communication
Socket.IO
Real-time state management
Event-driven programming
Authentication
Password hashing
SQLite database integration
Session management
Reconnection handling
Timer-based game logic
Real-time leaderboards
Git and GitHub workflow
📌 Current Status

Development status: Working prototype

The core live quiz workflow has been tested end-to-end, including:

Quiz lobby creation
Player joining
Live questions
Answer submission
Timers
Automatic question progression
Scoring
Leaderboards
Final results
Player reconnection
Host session recovery
🔮 Future Improvements

Potential future improvements include:

Improved analytics and reporting
More advanced quiz management
Additional question types
Persistent game history
Better mobile responsiveness
Automated testing
Production deployment
Containerization with Docker
Improved security and authorization
Cloud deployment

👨‍💻 Project

QuizLive

GitHub:
https://github.com/milesmorales-cloud/quizlive

📄 License

This project is currently intended as a learning and academic project.
