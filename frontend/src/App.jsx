import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = 'http://localhost:3000';
const DEFAULT_TURN_STATE = { actionPlayed: false, minionPlayed: false };
const MINION_TARGETING_MODES = ['ally-minion', 'enemy-minion', 'neutral-minion'];
const socket = io(SOCKET_URL);

function App() {
  // Room and lobby state
  const [playerName, setPlayerName] = useState('');
  const [roomIdInput, setRoomIdInput] = useState('');
  const [currentRoom, setCurrentRoom] = useState(null);
  const [players, setPlayers] = useState([]);
  const [spectators, setSpectators] = useState([]);
  const [isHost, setIsHost] = useState(false);

  // Game state
  const [gamePhase, setGamePhase] = useState('lobby');
  const [draftState, setDraftState] = useState(null);
  const [activeBases, setActiveBases] = useState([]);
  const [currentTurnPlayerId, setCurrentTurnPlayerId] = useState(null);
  const [turnState, setTurnState] = useState(DEFAULT_TURN_STATE);
  const [battleLog, setBattleLog] = useState([]);
  const [myHand, setMyHand] = useState([]);
  const [myDiscard, setMyDiscard] = useState([]);

  // UI state
  const [selectedCardDetail, setSelectedCardDetail] = useState(null);
  const [selectedCardToPlay, setSelectedCardToPlay] = useState(null);
  const [targetingMode, setTargetingMode] = useState(null);
  const [showDiscardModal, setShowDiscardModal] = useState(false);

  useEffect(() => {
    socket.on('room-created', ({ roomId, players, host }) => {
      setCurrentRoom(roomId);
      setPlayers(players);
      setIsHost(host === socket.id);
    });

    socket.on('room-joined', ({ roomId, players, spectators, host }) => {
      setCurrentRoom(roomId);
      setPlayers(players);
      if (spectators) setSpectators(spectators);
      setIsHost(host === socket.id);
    });

    socket.on('spectate-started', ({ roomId, players, activeBases, spectators }) => {
      setCurrentRoom(roomId);
      setPlayers(players);
      if (activeBases) setActiveBases(activeBases);
      if (spectators) setSpectators(spectators);
      setGamePhase('spectating');
    });

    socket.on('update-players', ({ players, spectators, host }) => {
      if (players) setPlayers(players);
      if (spectators) setSpectators(spectators);
      if (host) {
        setIsHost(host === socket.id);
      }
    });

    socket.on('draft-started', ({ draftState, players, spectators }) => {
      setGamePhase('drafting');
      setDraftState(draftState);
      setPlayers(players);
      if (spectators) setSpectators(spectators);
    });

    socket.on('draft-update', ({ draftState }) => {
      setDraftState(draftState);
    });

    socket.on('game-started', ({ players, activeBases, spectators, currentTurnPlayerId, turnState, gamePhase, battleLog }) => {
      setGamePhase(gamePhase || 'playing');
      setPlayers(players);
      if (activeBases) setActiveBases(activeBases);
      if (spectators) setSpectators(spectators);
      if (currentTurnPlayerId) setCurrentTurnPlayerId(currentTurnPlayerId);
      if (turnState) setTurnState(turnState);
      if (battleLog) setBattleLog(battleLog);

      const me = players.find(p => p.id === socket.id);
      if (me) {
        if (me.hand) setMyHand(me.hand);
        if (me.discardPile) setMyDiscard(me.discardPile);
      }
    });

    socket.on('game-state-update', ({ players, activeBases, currentTurnPlayerId, turnState, spectators, gamePhase, battleLog }) => {
      if (gamePhase) setGamePhase(gamePhase);
      setPlayers(players);
      if (activeBases) setActiveBases(activeBases);
      if (currentTurnPlayerId) setCurrentTurnPlayerId(currentTurnPlayerId);
      if (turnState) setTurnState(turnState);
      if (spectators) setSpectators(spectators);
      if (battleLog) setBattleLog(battleLog);

      const me = players.find(p => p.id === socket.id);
      if (me) {
        if (me.hand) setMyHand(me.hand);
        if (me.discardPile) setMyDiscard(me.discardPile);
      }
    });

    socket.on('room-reset', ({ message }) => {
      if (message) {
        alert(message);
      }
      resetAppToLobby();
    });

    socket.on('error', (errMessage) => {
      alert(errMessage);
    });

    return () => {
      socket.off('room-created');
      socket.off('room-joined');
      socket.off('spectate-started');
      socket.off('update-players');
      socket.off('draft-started');
      socket.off('draft-update');
      socket.off('game-started');
      socket.off('game-state-update');
      socket.off('room-reset');
      socket.off('error');
    };
  }, []);

  const resetAppToLobby = () => {
    setCurrentRoom(null);
    setPlayers([]);
    setSpectators([]);
    setIsHost(false);
    setGamePhase('lobby');
    setDraftState(null);
    setRoomIdInput('');
    setMyHand([]);
    setMyDiscard([]);
    setActiveBases([]);
    setCurrentTurnPlayerId(null);
    setTurnState(DEFAULT_TURN_STATE);
    setBattleLog([]);
    setSelectedCardDetail(null);
    setSelectedCardToPlay(null);
    setTargetingMode(null);
    setShowDiscardModal(false);
  };

  const handleCreateRoom = () => {
    if (!playerName) return alert('Please enter your name first!');
    socket.emit('create-room', { playerName });
  };

  const handleJoinRoom = () => {
    if (!playerName || !roomIdInput) return alert('Please enter your name and a room code!');
    socket.emit('join-room', { roomId: roomIdInput.toUpperCase(), playerName });
  };

  const handleStartGame = () => {
    socket.emit('start-game', { roomId: currentRoom });
  };

  const handleDraftFaction = (factionName) => {
    socket.emit('draft-faction', { roomId: currentRoom, factionName });
  };

  const handlePlayCard = (cardInstanceId, baseIndex = null, targetMinionInstanceId = null) => {
    socket.emit('play-card', { roomId: currentRoom, cardInstanceId, baseIndex, targetMinionInstanceId });
  };

  const handleEndTurn = () => {
    socket.emit('end-turn', { roomId: currentRoom });
  };

  const handleLeaveRoom = () => {
    if (currentRoom) {
      socket.emit('leave-room', { roomId: currentRoom });
    }
    resetAppToLobby();
  };

  // --- 1. SPECTATOR SCREEN ---
  if (gamePhase === 'spectating') {
    return (
      <div style={{ padding: '30px', fontFamily: 'Arial, sans-serif' }}>
        <h1>Smash Up - Spectator Mode 👀</h1>
        <h2>Room Code: <span style={{ color: 'blue' }}>{currentRoom}</span></h2>
        <p><em>You joined after the game started. You are spectating live!</em></p>

        <div style={{ display: 'flex', gap: '30px' }}>
          <div style={{ flex: '1', background: '#f4f4f4', padding: '15px', borderRadius: '8px', minWidth: '240px' }}>
            <h3>Players in Match:</h3>
            <ul>
              {players.map((p, index) => (
                <li key={index} style={{ marginBottom: '10px' }}>
                  <strong>{p.name}</strong> {p.id === currentTurnPlayerId ? '⭐ (Active Turn)' : ''}
                  <div style={{ fontSize: '12px', color: '#444' }}>
                    Factions: {p.factions ? p.factions.join(' & ') : 'Drafting...'}
                  </div>
                  <div style={{ fontSize: '11px', color: '#666' }}>
                    Deck: {p.deck ? p.deck.length : 0} | Hand: {p.hand ? p.hand.length : 0}
                  </div>
                </li>
              ))}
            </ul>

            <h3 style={{ marginTop: '20px', borderTop: '1px solid #ddd', paddingTop: '10px' }}>Spectators ({spectators.length}):</h3>
            {spectators.length === 0 ? (
              <p style={{ fontSize: '12px', color: '#777', fontStyle: 'italic' }}>No other spectators</p>
            ) : (
              <ul>
                {spectators.map((s, index) => (
                  <li key={index} style={{ fontSize: '13px', marginBottom: '5px' }}>
                    👁️ {s.name} {s.id === socket.id ? '(You)' : ''}
                  </li>
                ))}
              </ul>
            )}

            <button
              onClick={handleLeaveRoom}
              style={{ marginTop: '20px', padding: '8px 12px', backgroundColor: '#d9534f', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
            >
              Leave Spectating
            </button>
          </div>

          <div style={{ flex: '3' }}>
            {/* Active Bases Row with Player Sub-groups and Total Power */}
            <h3>Active Bases:</h3>
            <div style={{ display: 'flex', gap: '15px', marginBottom: '30px', overflowX: 'auto', paddingBottom: '10px' }}>
              {activeBases.map((base, idx) => {
                const cardsByPlayer = {};
                if (base.playedCards) {
                  base.playedCards.forEach(card => {
                    const ownerId = card.ownerName || 'Unknown';
                    if (!cardsByPlayer[ownerId]) cardsByPlayer[ownerId] = [];
                    cardsByPlayer[ownerId].push(card);
                  });
                }

                return (
                  <div
                    key={idx}
                    style={{
                      border: '3px solid #2c3e50',
                      borderRadius: '10px',
                      padding: '15px',
                      width: '260px',
                      background: '#fff9e6',
                      boxShadow: '0 4px 8px rgba(0,0,0,0.1)'
                    }}
                  >
                    <div style={{ fontWeight: 'bold', fontSize: '16px', color: '#2c3e50' }}>{base.name}</div>
                    <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#d9534f', margin: '4px 0' }}>
                      Breakpoint: {base.breakpoint}
                    </div>
                    <div style={{ fontSize: '12px', color: '#333', marginBottom: '6px' }}>
                      <strong>VP:</strong> {base.vp.join(' - ')}
                    </div>
                    <div style={{ fontSize: '11px', fontStyle: 'italic', color: '#555', borderTop: '1px solid #ddd', paddingTop: '4px', marginBottom: '10px' }}>
                      {base.ability}
                    </div>

                    {/* Cards Container on Base Grouped by Player */}
                    <div style={{ background: '#f4f4f4', border: '1px solid #ddd', borderRadius: '6px', padding: '8px', minHeight: '100px' }}>
                      <div style={{ fontSize: '11px', fontWeight: 'bold', marginBottom: '6px', color: '#444' }}>Cards on Base:</div>

                      {Object.keys(cardsByPlayer).length === 0 && (
                        <div style={{ fontSize: '10px', color: '#888', fontStyle: 'italic' }}>No cards played here yet</div>
                      )}

                      {Object.entries(cardsByPlayer).map(([playerName, cards]) => {
                        const totalPower = cards.reduce((sum, card) => {
                          return card.type === 'minion' && typeof card.power === 'number' ? sum + card.power : sum;
                        }, 0);

                        return (
                          <div key={playerName} style={{ marginBottom: '8px', background: '#e9ecef', padding: '6px', borderRadius: '4px' }}>
                            <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#007bff', marginBottom: '4px', borderBottom: '1px solid #d6d8db', paddingBottom: '2px', display: 'flex', justifyContent: 'space-between' }}>
                              <span>{playerName}'s Cards ({cards.length})</span>
                              <span style={{ color: '#28a745' }}>Total Power: {totalPower}</span>
                            </div>
                            {cards.map(card => (
                              <div
                                key={card.instanceId}
                                style={{
                                  background: card.type === 'minion' ? '#eef6fc' : '#fcf4ee',
                                  border: '1px solid #bbb',
                                  borderRadius: '4px',
                                  padding: '5px',
                                  marginBottom: '4px',
                                  fontSize: '10px'
                                }}
                              >
                                <div style={{ fontWeight: 'bold' }}>{card.name}</div>
                                <div style={{ color: '#555' }}>
                                  {card.type === 'minion' ? `${card.power} Power` : 'Action'}
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- 2. DRAFTING PHASE SCREEN ---
  if (gamePhase === 'drafting') {
    const isMyTurn = draftState?.currentPickerId === socket.id;
    const currentPicker = players.find(p => p.id === draftState?.currentPickerId);

    return (
      <div style={{ padding: '30px', fontFamily: 'Arial, sans-serif' }}>
        <h1>Smash Up - Faction Draft Phase</h1>
        <h2>Room Code: <span style={{ color: 'blue' }}>{currentRoom}</span></h2>

        <div style={{ display: 'flex', gap: '30px' }}>
          <div style={{ flex: '3' }}>
            <div style={{ background: isMyTurn ? '#d4edda' : '#fff3cd', padding: '15px', borderRadius: '6px', marginBottom: '20px' }}>
              <h3>{isMyTurn ? "👉 It's Your Turn to Pick a Faction!" : `⏳ Waiting for ${currentPicker?.name || 'someone'} to pick...`}</h3>
            </div>

            <h3>Available Factions:</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '15px', marginBottom: '30px' }}>
              {draftState?.availableFactions.map((faction) => (
                <button
                  key={faction}
                  onClick={() => handleDraftFaction(faction)}
                  disabled={!isMyTurn}
                  style={{
                    padding: '20px 30px',
                    fontSize: '18px',
                    fontWeight: 'bold',
                    backgroundColor: isMyTurn ? '#007bff' : '#cccccc',
                    color: 'white',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: isMyTurn ? 'pointer' : 'not-allowed',
                    boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
                  }}
                >
                  {faction}
                </button>
              ))}
            </div>

            <h3>Current Draft Picks:</h3>
            <ul>
              {players.map((p) => (
                <li key={p.id} style={{ marginBottom: '8px' }}>
                  <strong>{p.name} {p.id === socket.id ? '(You)' : ''}:</strong>{' '}
                  {draftState?.picks[p.id]?.length > 0
                    ? draftState.picks[p.id].join(' + ')
                    : '<em>No picks yet</em>'}
                </li>
              ))}
            </ul>
          </div>

          <div style={{ flex: '1', background: '#f4f4f4', padding: '15px', borderRadius: '8px', minWidth: '220px', height: 'fit-content' }}>
            <h3>Spectators ({spectators.length}):</h3>
            {spectators.length === 0 ? (
              <p style={{ fontSize: '12px', color: '#777', fontStyle: 'italic' }}>None</p>
            ) : (
              <ul>
                {spectators.map((s, index) => (
                  <li key={index} style={{ fontSize: '13px', marginBottom: '5px' }}>
                    👁️ {s.name} {s.id === socket.id ? '(You)' : ''}
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={handleLeaveRoom}
              style={{ marginTop: '20px', padding: '8px 12px', backgroundColor: '#d9534f', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
            >
              Leave Room
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- 3. GAME IN PROGRESS & SCORING SCREENS ---
  if (gamePhase === 'playing' || gamePhase === 'scoring') {
    const me = players.find(p => p.id === socket.id);
    const isMyTurn = currentTurnPlayerId === socket.id;
    const activePlayer = players.find(p => p.id === currentTurnPlayerId);
    const topDiscardCard = myDiscard.length > 0 ? myDiscard[myDiscard.length - 1] : null;

    return (
      <div style={{ padding: '30px', fontFamily: 'Arial, sans-serif' }}>
        <h1>Smash Up - Match Active</h1>
        <h2>Room Code: <span style={{ color: 'blue' }}>{currentRoom}</span></h2>

        {/* Scoring Phase Notification Banner */}
        {gamePhase === 'scoring' && (
          <div style={{
            background: '#ffc107',
            color: '#333',
            padding: '15px',
            borderRadius: '8px',
            textAlign: 'center',
            fontWeight: 'bold',
            fontSize: '18px',
            marginBottom: '20px',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
          }}>
            ⚡ BASE SCORING PHASE IN PROGRESS! Distributing VP and resolving bases...
          </div>
        )}

        {/* Turn Status Banner */}
        <div style={{
          background: isMyTurn ? '#d4edda' : '#fff3cd',
          padding: '12px 20px',
          borderRadius: '8px',
          marginBottom: '20px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
        }}>
          <div>
            <h3 style={{ margin: 0 }}>
              {isMyTurn ? "⭐ It's Your Turn!" : `⏳ Waiting for ${activePlayer?.name || 'someone'} to finish their turn...`}
            </h3>
            <div style={{ fontSize: '12px', marginTop: '4px', color: '#555' }}>
              Action Played: {turnState.actionPlayed ? '✅ (1/1)' : '❌ (0/1)'} | Minion Played: {turnState.minionPlayed ? '✅ (1/1)' : '❌ (0/1)'}
            </div>
          </div>
          {isMyTurn && gamePhase === 'playing' && (
            <button
              onClick={handleEndTurn}
              style={{
                padding: '10px 20px',
                backgroundColor: '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontWeight: 'bold',
                cursor: 'pointer',
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
              }}
            >
              End Turn (Draw 2)
            </button>
          )}
        </div>

        {me?.factions && <h3>Your Factions: <span style={{ color: 'green' }}>{me.factions.join(' & ')}</span></h3>}

        <div style={{ display: 'flex', gap: '30px' }}>
          <div style={{ flex: '1', background: '#f4f4f4', padding: '15px', borderRadius: '8px', minWidth: '240px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

              {/* Players List */}
              <div>
                <h3>Players in Game:</h3>
                <ul style={{ paddingLeft: '20px', margin: 0 }}>
                  {players.map((p, index) => {
                    const isMe = p.id === socket.id;
                    const discardCount = p.discardPile ? p.discardPile.length : 0;
                    const playerVp = p.vp !== undefined ? p.vp : 0;
                    return (
                      <li key={index} style={{ marginBottom: '12px', borderBottom: '1px solid #ddd', paddingBottom: '8px' }}>
                        <strong>{p.name}</strong> {isMe ? '(You)' : ''} {p.id === currentTurnPlayerId ? '⭐' : ''}
                        <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#d9534f', margin: '2px 0' }}>
                          🏆 Victory Points (VP): {playerVp}
                        </div>
                        <div style={{ fontSize: '12px', color: '#444' }}>
                          Factions: {p.factions ? p.factions.join(' & ') : 'None'}
                        </div>
                        <div style={{ fontSize: '11px', color: '#666' }}>
                          Deck: {p.deck ? p.deck.length : 0} | Hand: {p.hand ? p.hand.length : 0}
                        </div>
                        <div style={{ fontSize: '11px', color: '#c0392b', fontWeight: 'bold' }}>
                          Discard Pile: {discardCount} {discardCount === 0 ? '(Empty)' : ''}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {/* Spectators List */}
              <div style={{ borderTop: '1px solid #ddd', paddingTop: '10px' }}>
                <h3>Spectators ({spectators.length}):</h3>
                {spectators.length === 0 ? (
                  <p style={{ fontSize: '12px', color: '#777', fontStyle: 'italic' }}>No spectators watching</p>
                ) : (
                  <ul style={{ paddingLeft: '20px', margin: 0 }}>
                    {spectators.map((s, index) => (
                      <li key={index} style={{ fontSize: '13px', marginBottom: '5px' }}>
                        👁️ {s.name} {s.id === socket.id ? '(You)' : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Battle log */}
              <div style={{ borderTop: '1px solid #ddd', paddingTop: '10px' }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: '15px' }}>Battle Log</h3>
                <div style={{
                  border: '1px solid #ccc',
                  borderRadius: '6px',
                  padding: '10px',
                  backgroundColor: '#fff',
                  maxHeight: '180px',
                  overflowY: 'auto'
                }}>
                  {battleLog.length === 0 ? (
                    <p style={{ fontSize: '11px', color: '#777', fontStyle: 'italic', margin: 0 }}>No actions played yet.</p>
                  ) : (
                    <ul style={{ paddingLeft: '15px', margin: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {battleLog.map((log, idx) => (
                        <li key={idx} style={{ fontSize: '11px', lineHeight: '1.3' }} dangerouslySetInnerHTML={{
                          __html: log.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                        }} />
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            <button
              onClick={handleLeaveRoom}
              style={{ marginTop: '20px', padding: '8px 12px', backgroundColor: '#d9534f', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
            >
              Leave Game
            </button>
          </div>

          <div style={{ flex: '3' }}>
            {/* Active Bases Row with Player Sub-groups and Total Power */}
            <h3>Active Bases:</h3>
            <div style={{ display: 'flex', gap: '15px', marginBottom: '30px', overflowX: 'auto', paddingBottom: '10px' }}>
              {activeBases.map((base, idx) => {
                const cardsByPlayer = {};
                if (base.playedCards) {
                  base.playedCards.forEach(card => {
                    const ownerName = card.ownerName || 'Unknown';
                    if (!cardsByPlayer[ownerName]) cardsByPlayer[ownerName] = [];
                    cardsByPlayer[ownerName].push(card);
                  });
                }

                return (
                  <div
                    key={idx}
                    style={{
                      border: '3px solid #2c3e50',
                      borderRadius: '10px',
                      padding: '15px',
                      width: '260px',
                      background: '#fff9e6',
                      boxShadow: '0 4px 8px rgba(0,0,0,0.1)'
                    }}
                  >
                    <div style={{ fontWeight: 'bold', fontSize: '16px', color: '#2c3e50' }}>{base.name}</div>
                    <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#d9534f', margin: '4px 0' }}>
                      Breakpoint: {base.breakpoint}
                    </div>
                    <div style={{ fontSize: '12px', color: '#333', marginBottom: '6px' }}>
                      <strong>VP:</strong> {base.vp.join(' - ')}
                    </div>
                    <div style={{ fontSize: '11px', fontStyle: 'italic', color: '#555', borderTop: '1px solid #ddd', paddingTop: '4px', marginBottom: '10px' }}>
                      {base.ability}
                    </div>

                    {/* Cards Container on Base Grouped by Player */}
                    <div style={{ background: '#f4f4f4', border: '1px solid #ddd', borderRadius: '6px', padding: '8px', minHeight: '100px' }}>
                      <div style={{ fontSize: '11px', fontWeight: 'bold', marginBottom: '6px', color: '#444' }}>Cards on Base:</div>

                      {Object.keys(cardsByPlayer).length === 0 && (
                        <div style={{ fontSize: '10px', color: '#888', fontStyle: 'italic' }}>No cards played here yet</div>
                      )}

                      {Object.entries(cardsByPlayer).map(([playerName, cards]) => {
                        // Separate minions from actions played directly to the base
                        const minions = cards.filter(c => c.type === 'minion');
                        const baseActions = cards.filter(c => c.type === 'action');

                        // Calculate total power (minion base power + power boosts from attached cards)
                        const totalPower = minions.reduce((sum, minion) => {
                          const attachBoost = (minion.attachedCards || []).reduce((aSum, att) => aSum + (att.powerBoost || 0), 0);
                          return sum + (typeof minion.power === 'number' ? minion.power : 0) + attachBoost;
                        }, 0) + baseActions.reduce((sum, act) => sum + (typeof act.power === 'number' ? act.power : 0), 0);

                        return (
                          <div key={playerName} style={{ marginBottom: '8px', background: '#e9ecef', padding: '6px', borderRadius: '4px' }}>
                            <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#007bff', marginBottom: '4px', borderBottom: '1px solid #d6d8db', paddingBottom: '2px', display: 'flex', justifyContent: 'space-between' }}>
                              <span>{playerName}'s Cards ({cards.length})</span>
                              <span style={{ color: '#28a745' }}>Total Power: {totalPower}</span>
                            </div>

                            {/* Render Minions with their Attached Cards */}
                            {minions.map(minion => {
                              const attachBoost = (minion.attachedCards || []).reduce((aSum, att) => aSum + (att.powerBoost || 0), 0);
                              const effectivePower = (minion.power || 0) + attachBoost;

                              return (
                                <div
                                  key={minion.instanceId}
                                  style={{
                                    background: '#eef6fc',
                                    border: '1px solid #bbb',
                                    borderRadius: '4px',
                                    padding: '6px',
                                    marginBottom: '6px',
                                    fontSize: '10px'
                                  }}
                                >
                                  <div
                                    onClick={() => setSelectedCardDetail(minion)}
                                    style={{ fontWeight: 'bold', cursor: 'pointer' }}
                                    title="Click to view full card details"
                                  >
                                    {minion.name}
                                  </div>
                                  <div
                                    onClick={() => setSelectedCardDetail(minion)}
                                    style={{ color: '#555', cursor: 'pointer' }}
                                    title="Click to view full card details"
                                  >
                                    Power: {effectivePower} {attachBoost !== 0 ? `(Base: ${minion.power})` : ''}
                                  </div>

                                  {/* Attached Cards Rendered Right Next To / Under the Target Minion */}
                                  {minion.attachedCards && minion.attachedCards.length > 0 && (
                                    <div style={{ marginTop: '4px', borderLeft: '2px solid #007bff', paddingLeft: '6px' }}>
                                      {minion.attachedCards.map(attCard => (
                                        <div
                                          key={attCard.instanceId}
                                          onClick={() => setSelectedCardDetail(attCard)}
                                          style={{
                                            background: '#fcf4ee',
                                            border: '1px dashed #007bff',
                                            borderRadius: '3px',
                                            padding: '4px',
                                            marginTop: '3px',
                                            cursor: 'pointer'
                                          }}
                                          title="Click to view attached card details"
                                        >
                                          <div style={{ fontWeight: 'bold', color: '#0056b3' }}>📎 {attCard.name}</div>
                                          <div style={{ fontSize: '9px', color: '#555' }}>{attCard.ability}</div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}

                            {/* Render Standalone Base Actions */}
                            {baseActions.map(action => (
                              <div
                                key={action.instanceId}
                                onClick={() => setSelectedCardDetail(action)}
                                style={{
                                  background: '#fcf4ee',
                                  border: '1px solid #bbb',
                                  borderRadius: '4px',
                                  padding: '6px',
                                  marginBottom: '4px',
                                  fontSize: '10px',
                                  cursor: 'pointer'
                                }}
                                title="Click to view full card details"
                              >
                                <div style={{ fontWeight: 'bold' }}>{action.name}</div>
                                <div style={{ color: '#555' }}>Action</div>
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* HAND DISPLAY WITH A SINGLE PLAY BUTTON */}
            <h3 style={{ marginTop: '10px' }}>Your Hand ({myHand.length} Cards):</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '30px' }}>
              {myHand.map((card) => (
                <div
                  key={card.instanceId}
                  style={{
                    border: '2px solid #333',
                    borderRadius: '8px',
                    padding: '12px',
                    width: '150px',
                    background: card.type === 'minion' ? '#eef6fc' : '#fcf4ee',
                    boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between'
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 'bold', fontSize: '14px' }}>{card.name}</div>
                    <div style={{ fontSize: '12px', color: '#555', textTransform: 'uppercase', margin: '4px 0' }}>
                      {card.type} {card.power !== undefined ? `(${card.power} Power)` : ''}
                    </div>
                    <div style={{ fontSize: '10px', color: '#777', fontStyle: 'italic' }}>{card.faction}</div>
                    <div style={{ fontSize: '11px', marginTop: '6px', marginBottom: '10px' }}>{card.ability}</div>
                  </div>

                  {/* Single Play Button depending on subtype */}
                  {isMyTurn && gamePhase === 'playing' && (
                    <div style={{ borderTop: '1px solid #ccc', paddingTop: '8px', textAlign: 'center' }}>
                      <button
                        onClick={() => {
                          if (card.subtype === 'base') {
                            setSelectedCardToPlay(card);
                            setTargetingMode('base');
                          } else if (MINION_TARGETING_MODES.includes(card.subtype)) {
                            setSelectedCardToPlay(card);
                            setTargetingMode(card.subtype);
                          } else {
                            handlePlayCard(card.instanceId);
                          }
                        }}
                        style={{
                          fontSize: '11px',
                          padding: '6px 12px',
                          backgroundColor: '#007bff',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontWeight: 'bold',
                          width: '100%'
                        }}
                      >
                        Play Card
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* DISCARD PILE DISPLAY */}
            <div>
              <h3>Your Discard Pile ({myDiscard.length}):</h3>
              <div
                onClick={() => setShowDiscardModal(true)}
                style={{
                  border: '2px dashed #999',
                  borderRadius: '8px',
                  padding: '12px',
                  width: '140px',
                  height: '110px',
                  background: '#eaeaea',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  textAlign: 'center',
                  cursor: 'pointer',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                }}
                title="Click to view all cards in your discard pile"
              >
                {topDiscardCard ? (
                  <div style={{ fontSize: '12px' }}>
                    <div style={{ fontWeight: 'bold' }}>{topDiscardCard.name}</div>
                    <div style={{ fontSize: '10px', color: '#555', marginTop: '4px' }}>Click to view all ({myDiscard.length})</div>
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: '#777', fontStyle: 'italic' }}>
                    Discard pile is empty
                  </div>
                )}
              </div>

              {/* DISCARD PILE POP-UP MODAL */}
              {showDiscardModal && (
                <div style={{
                  position: 'fixed',
                  top: 0, left: 0, width: '100vw', height: '100vh',
                  backgroundColor: 'rgba(0, 0, 0, 0.6)',
                  display: 'flex', justifyContent: 'center', alignItems: 'center',
                  zIndex: 1000
                }}>
                  <div style={{
                    padding: '30px',
                    borderRadius: '10px',
                    width: '500px',
                    maxHeight: '80vh',
                    overflowY: 'auto',
                    boxShadow: '0 5px 15px rgba(0,0,0,0.3)',
                    textAlign: 'left'
                  }}>
                    <h2 style={{ marginTop: 0, borderBottom: '2px solid #ddd', paddingBottom: '10px' }}>
                      Your Discard Pile ({myDiscard.length} Cards)
                    </h2>

                    {myDiscard.length === 0 ? (
                      <p style={{ fontStyle: 'italic', color: '#777' }}>Your discard pile is currently empty.</p>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', margin: '20px 0' }}>
                        {myDiscard.map((card, idx) => (
                          <div
                            key={card.instanceId || idx}
                            style={{
                              border: '2px solid #333',
                              borderRadius: '8px',
                              padding: '10px',
                              width: '130px',
                              background: card.type === 'minion' ? '#eef6fc' : '#fcf4ee',
                              boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                            }}
                          >
                            <div style={{ fontWeight: 'bold', fontSize: '13px' }}>{card.name}</div>
                            <div style={{ fontSize: '11px', color: '#555', textTransform: 'uppercase', margin: '3px 0' }}>
                              {card.type} {card.power !== undefined ? `(${card.power} Pwr)` : ''}
                            </div>
                            <div style={{ fontSize: '9px', color: '#777', fontStyle: 'italic' }}>{card.faction}</div>
                            <div style={{ fontSize: '10px', marginTop: '4px' }}>{card.ability}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    <button
                      onClick={() => setShowDiscardModal(false)}
                      style={{
                        padding: '10px 20px',
                        fontSize: '15px',
                        backgroundColor: '#d9534f',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        float: 'right'
                      }}
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}

              {/* CARD DETAIL POP-UP MODAL */}
              {selectedCardDetail && (
                <div style={{
                  position: 'fixed',
                  top: 0, left: 0, width: '100vw', height: '100vh',
                  backgroundColor: 'rgba(0, 0, 0, 0.6)',
                  display: 'flex', justifyContent: 'center', alignItems: 'center',
                  zIndex: 2000
                }}>
                  <div style={{
                    background: 'white',
                    padding: '30px',
                    borderRadius: '10px',
                    width: '350px',
                    boxShadow: '0 5px 15px rgba(0,0,0,0.3)',
                    textAlign: 'center',
                    background: selectedCardDetail.type === 'minion' ? '#eef6fc' : '#fcf4ee'
                  }}>
                    <h2 style={{ marginTop: 0, marginBottom: '10px' }}>{selectedCardDetail.name}</h2>
                    <div style={{ fontSize: '13px', color: '#555', textTransform: 'uppercase', fontWeight: 'bold', marginBottom: '8px' }}>
                      {selectedCardDetail.type} {selectedCardDetail.power !== undefined ? `• Power: ${selectedCardDetail.power}` : ''}
                    </div>
                    <div style={{ fontSize: '11px', color: '#777', fontStyle: 'italic', marginBottom: '15px' }}>
                      Faction: {selectedCardDetail.faction}
                    </div>

                    <div style={{
                      background: 'white',
                      padding: '12px',
                      borderRadius: '6px',
                      border: '1px solid #ccc',
                      fontSize: '13px',
                      textAlign: 'left',
                      marginBottom: '20px',
                      minHeight: '60px'
                    }}>
                      <strong>Ability:</strong><br />
                      {selectedCardDetail.ability || 'No special ability.'}
                    </div>

                    <button
                      onClick={() => setSelectedCardDetail(null)}
                      style={{
                        padding: '10px 20px',
                        fontSize: '14px',
                        backgroundColor: '#007bff',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        width: '100%'
                      }}
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}

              {/* TARGETING POP-UP MODAL */}
              {selectedCardToPlay && targetingMode && (
                <div style={{
                  position: 'fixed',
                  top: 0, left: 0, width: '100vw', height: '100vh',
                  backgroundColor: 'rgba(0, 0, 0, 0.6)',
                  display: 'flex', justifyContent: 'center', alignItems: 'center',
                  zIndex: 1000
                }}>
                  <div style={{
                    background: 'white',
                    padding: '30px',
                    borderRadius: '10px',
                    width: '380px',
                    boxShadow: '0 5px 15px rgba(0,0,0,0.3)',
                    textAlign: 'center'
                  }}>
                    <h3 style={{ marginTop: 0 }}>Play "{selectedCardToPlay.name}"</h3>

                    {targetingMode === 'base' && (
                      <>
                        <p style={{ fontSize: '13px', color: '#555' }}>Select a base to target:</p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', margin: '20px 0' }}>
                          {activeBases.map((base, bIdx) => (
                            <button
                              key={bIdx}
                              onClick={() => {
                                handlePlayCard(selectedCardToPlay.instanceId, bIdx);
                                setSelectedCardToPlay(null);
                                setTargetingMode(null);
                              }}
                              style={{
                                padding: '10px',
                                fontSize: '14px',
                                fontWeight: 'bold',
                                backgroundColor: '#28a745',
                                color: 'white',
                                border: 'none',
                                borderRadius: '6px',
                                cursor: 'pointer'
                              }}
                            >
                              Base {bIdx + 1}: {base.name}
                            </button>
                          ))}
                        </div>
                      </>
                    )}

                    {(targetingMode === 'ally-minion' || targetingMode === 'enemy-minion' || targetingMode === 'neutral-minion') && (
                      <>
                        <p style={{ fontSize: '13px', color: '#555' }}>
                          {targetingMode === 'ally-minion'
                            ? 'Select one of your own minions from the list below:'
                            : targetingMode === 'enemy-minion'
                              ? 'Select an enemy minion from the list below:'
                              : 'Select any minion (ally or enemy) from the list below:'}
                        </p>
                        <div style={{
                          maxHeight: '200px',
                          overflowY: 'auto',
                          margin: '15px 0',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '8px'
                        }}>
                          {activeBases.flatMap((base, bIdx) =>
                            (base.playedCards || [])
                              .filter(card => card.type === 'minion')
                              .filter(m => {
                                const ownerId = m.ownerId || m.owner;
                                if (targetingMode === 'ally-minion') return ownerId === socket.id;
                                if (targetingMode === 'enemy-minion') return ownerId !== socket.id;
                                return true; // 'neutral-minion' matches everything!
                              })
                              .map((minion) => (
                                <button
                                  key={minion.instanceId}
                                  onClick={() => {
                                    handlePlayCard(selectedCardToPlay.instanceId, bIdx, minion.instanceId);
                                    setSelectedCardToPlay(null);
                                    setTargetingMode(null);
                                  }}
                                  style={{
                                    padding: '10px',
                                    fontSize: '13px',
                                    backgroundColor: targetingMode === 'ally-minion' ? '#17a2b8' : targetingMode === 'enemy-minion' ? '#dc3545' : '#6f42c1',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    fontWeight: 'bold'
                                  }}
                                >
                                  {minion.name} (Power: {minion.power}) at Base {bIdx + 1}
                                </button>
                              ))
                          )}

                          {/* Fallback check */}
                          {activeBases.every(base => (base.playedCards || []).filter(c => c.type === 'minion').filter(m => {
                            const ownerId = m.ownerId || m.owner;
                            if (targetingMode === 'ally-minion') return ownerId === socket.id;
                            if (targetingMode === 'enemy-minion') return ownerId !== socket.id;
                            return true;
                          }).length === 0) && (
                              <p style={{ fontSize: '12px', color: '#999', fontStyle: 'italic' }}>
                                No eligible minions currently on the board.
                              </p>
                            )}
                        </div>
                      </>
                    )}

                    <button
                      onClick={() => {
                        setSelectedCardToPlay(null);
                        setTargetingMode(null);
                      }}
                      style={{
                        padding: '8px 16px',
                        fontSize: '14px',
                        backgroundColor: '#6c757d',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        width: '100%',
                        marginTop: '10px'
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- 4. LOBBY SCREEN ---
  return (
    <div style={{ padding: '40px', fontFamily: 'Arial, sans-serif' }}>
      <h1>Smash Up Multiplayer Lobby</h1>

      {!currentRoom ? (
        <div>
          <div style={{ marginBottom: '15px' }}>
            <label>Your Name: </label>
            <input
              type="text"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              placeholder="Enter name..."
            />
          </div>

          <div style={{ marginBottom: '15px' }}>
            <button onClick={handleCreateRoom}>Create Room</button>
          </div>

          <hr />

          <div>
            <label>Room Code: </label>
            <input
              type="text"
              value={roomIdInput}
              onChange={(e) => setRoomIdInput(e.target.value)}
              placeholder="e.g. A1B2C"
            />
            <button onClick={handleJoinRoom} style={{ marginLeft: '10px' }}>Join Room</button>
          </div>
        </div>
      ) : (
        <div>
          <h2>Room Code: <span style={{ color: 'blue' }}>{currentRoom}</span></h2>
          <h3>Players in Lobby:</h3>
          <ul>
            {players.map((p, index) => (
              <li key={index}>
                {p.name} {p.id === socket.id ? '(You)' : ''}
                {index === 0 ? ' 👑 (Host)' : ''}
              </li>
            ))}
          </ul>

          {isHost ? (
            <div style={{ marginTop: '20px' }}>
              <button
                onClick={handleStartGame}
                style={{ padding: '10px 20px', fontSize: '16px', backgroundColor: 'green', color: 'white', cursor: 'pointer', marginRight: '10px' }}
              >
                Start Game
              </button>
              <button
                onClick={handleLeaveRoom}
                style={{ padding: '10px 20px', fontSize: '16px', backgroundColor: '#d9534f', color: 'white', cursor: 'pointer' }}
              >
                Leave Room
              </button>
            </div>
          ) : (
            <div style={{ marginTop: '20px' }}>
              <p><em>Waiting for the host to start the game...</em></p>
              <button
                onClick={handleLeaveRoom}
                style={{ padding: '8px 15px', backgroundColor: '#d9534f', color: 'white', cursor: 'pointer' }}
              >
                Leave Room
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
