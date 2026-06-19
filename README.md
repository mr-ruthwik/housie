# Housie Multiplayer Game

A real-time, interactive Tambola/Housie multiplayer web game. Players can create rooms, join with a room code, generate tickets, and compete in patterns like Jaldi 5, Lines, and Full House.

## Features
* **Multiplayer Support**: Create or join rooms using unique room codes powered by PeerJS.
* **Real-time Gameplay**: Host can generate numbers that sync instantly across all connected clients.
* **Interactive Tickets**: Tap numbers to mark them as you play.
* **Pattern Validation**: Support for claiming patterns like Jaldi 5, Lines, and Full House.
* **Dynamic UI**: Responsive design with a game lobby, member list, and live caller board.

## Tech Stack
* **Frontend**: HTML5, CSS3, JavaScript (Vanilla)
* **Networking**: PeerJS (for WebRTC P2P connections)

## How to Play
1. **Enter Name**: Choose your display name and ticket count (1-4).
2. **Lobby**: Create a room to host or join an existing room with a code.
3. **Gameplay**:
    - Host draws numbers using the "Generate Number" button.
    - Players tap their tickets when numbers match.
    - Claim prizes as you complete patterns!
