import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.DEV
    ? 'http://localhost:3000'
    : window.location.origin);

const DEFAULT_TURN_STATE = {
  actionPlayed: false,
  minionPlayed: false,
  extraActionPlays: 0,
  extraMinionPlays: [],
  talentUses: {}
};
const MINION_TARGETING_MODES = ['ally-minion', 'enemy-minion', 'neutral-minion'];
const BOT_POLICY_OPTIONS = [
  { value: 'random-v1', label: 'Random' },
  { value: 'greedy_heuristic_1', label: 'Greedy heuristic 1' },
  { value: 'greedy_heuristic_2', label: 'Greedy heuristic 2' }
];
const BOT_POLICY_LABELS = Object.fromEntries(BOT_POLICY_OPTIONS.map(option => [option.value, option.label]));
const BOT_POLICY_DESCRIPTIONS = {
  'random-v1': 'Chooses randomly from every legal action.',
  greedy_heuristic_1: 'Plays stronger minions toward the bases with the most power.',
  greedy_heuristic_2: 'Plays stronger minions toward the bases with the least power.'
};
const DEFAULT_BOT_MODE_POLICIES = ['random-v1', 'greedy_heuristic_1'];
const getPlayerDisplayName = player => (
  `${player.name}${player.isBot
    ? ` (${(BOT_POLICY_LABELS[player.policyVersion] || 'Random').toLowerCase()})`
    : ''}`
);
const socket = io(SOCKET_URL);

function CardLogButton({ card, onCardClick }) {
  return (
    <button
      type="button"
      onClick={() => onCardClick(card)}
      style={{
        background: 'none',
        border: 'none',
        color: 'inherit',
        cursor: 'pointer',
        display: 'inline',
        font: 'inherit',
        fontWeight: 'bold',
        margin: 0,
        padding: 0,
        textDecoration: 'underline',
        verticalAlign: 'baseline',
        whiteSpace: 'normal'
      }}
      title="View card details"
    >
      {card.name}
    </button>
  );
}

function BattleLogEntry({ entry, onCardClick }) {
  if (typeof entry !== 'string' && entry.revealed && entry.card) {
    return (
      <>
        <strong>{entry.playerName}</strong>{' reveals '}<CardLogButton card={entry.card} onCardClick={onCardClick} />
      </>
    );
  }

  if (typeof entry !== 'string' && entry.card && entry.playerName) {
    return (
      <>
        <strong>{entry.playerName}</strong>{' plays '}<CardLogButton card={entry.card} onCardClick={onCardClick} />
        {entry.targetName && (
          <>
            {' on '}
            {entry.targetCard ? (
              <CardLogButton card={entry.targetCard} onCardClick={onCardClick} />
            ) : (
              <strong>{entry.targetName}</strong>
            )}
          </>
        )}
      </>
    );
  }

  const message = typeof entry === 'string' ? entry : entry.message;

  return message.split(/(\*\*.*?\*\*)/g).filter(Boolean).map((part, index) => {
    const isBold = part.startsWith('**') && part.endsWith('**');
    const text = isBold ? part.slice(2, -2) : part;

    return isBold ? <strong key={`${text}-${index}`}>{text}</strong> : part;
  });
}

function GameRulesHelp() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isOpen]);

  return (
    <>
      <button
        type="button"
        aria-label="Open game rules"
        title="Game rules"
        onClick={() => setIsOpen(true)}
        style={{
          alignItems: 'center',
          background: '#2c3e50',
          border: '2px solid white',
          borderRadius: '6px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          color: 'white',
          cursor: 'pointer',
          display: 'flex',
          fontSize: '24px',
          fontWeight: 'bold',
          height: '42px',
          justifyContent: 'center',
          padding: 0,
          position: 'fixed',
          right: '18px',
          top: '18px',
          width: '42px',
          zIndex: 1500
        }}
      >
        ?
      </button>

      {isOpen && (
        <div
          role="presentation"
          onClick={() => setIsOpen(false)}
          style={{
            alignItems: 'center',
            background: 'rgba(0, 0, 0, 0.65)',
            display: 'flex',
            inset: 0,
            justifyContent: 'center',
            padding: '20px',
            position: 'fixed',
            zIndex: 5000
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="game-rules-title"
            onClick={(event) => event.stopPropagation()}
            style={{
              background: 'white',
              borderRadius: '10px',
              boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
              boxSizing: 'border-box',
              color: '#222',
              maxHeight: '85vh',
              maxWidth: '680px',
              overflowY: 'auto',
              padding: '28px',
              width: '100%'
            }}
          >
            <div style={{ alignItems: 'center', display: 'flex', gap: '16px', justifyContent: 'space-between' }}>
              <h2 id="game-rules-title" style={{ margin: 0 }}>How to Play Smash Up</h2>
              <button
                type="button"
                aria-label="Close game rules"
                onClick={() => setIsOpen(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#555',
                  cursor: 'pointer',
                  fontSize: '26px',
                  lineHeight: 1,
                  padding: '2px 6px'
                }}
              >
                ×
              </button>
            </div>

            <div style={{ fontSize: '14px', lineHeight: 1.55 }}>
              <h3>Goal</h3>
              <p>Earn victory points by helping bases score. Reach 15 VP; if the leaders are tied, continue until the tie is broken.</p>

              <h3>Faction draft</h3>
              <p>Up to four players draft two factions each. The draft moves through the player order, then reverses so everyone receives two picks.</p>

              <h3>Your turn</h3>
              <ol style={{ paddingLeft: '22px' }}>
                <li>Play up to one minion and up to one action, in either order.</li>
                <li>Resolve every required card or base ability choice.</li>
                <li>Use each Talent no more than once during your turn.</li>
                <li>End your turn. Bases at or above their breakpoint then score, and you draw two cards.</li>
              </ol>

              <h3>Playing cards</h3>
              <p>Minions normally go on a base and contribute power there. Actions follow their card text and may be discarded immediately or remain attached to a base or minion.</p>

              <h3>Scoring a base</h3>
              <p>Compare each player&apos;s total minion power at that base. First, second, and third place receive the VP values printed on the base. Resolve scoring abilities, discard cards that do not remain in play, then reveal a replacement base.</p>

              <h3>Ability timing</h3>
              <ul style={{ paddingLeft: '22px' }}>
                <li><strong>On play:</strong> resolves when the card is played.</li>
                <li><strong>Ongoing:</strong> remains active while the card is in play.</li>
                <li><strong>Talent:</strong> may be activated once on its controller&apos;s turn.</li>
                <li><strong>Special:</strong> resolves at the time described by the card.</li>
              </ul>

              <p style={{ background: '#eef6fc', borderRadius: '6px', marginBottom: 0, padding: '12px' }}>
                Click a card or a linked card name in the battle log to read its full text. When a choice window is open, resolve or skip it before continuing.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setIsOpen(false)}
              style={{
                background: '#007bff',
                border: 'none',
                borderRadius: '6px',
                color: 'white',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 'bold',
                marginTop: '22px',
                padding: '10px 18px',
                width: '100%'
              }}
            >
              Close Rules
            </button>
          </section>
        </div>
      )}
    </>
  );
}

function BotModeSetup({
  botCount,
  error,
  isRunning,
  policyVersions,
  onBack,
  onBotCountChange,
  onPolicyChange,
  onRun
}) {
  return (
    <main
      style={{
        background: 'linear-gradient(145deg, #eaf3fb 0%, #f8f4df 100%)',
        boxSizing: 'border-box',
        fontFamily: 'Arial, sans-serif',
        minHeight: '100vh',
        padding: '48px 20px'
      }}
    >
      <GameRulesHelp />
      <section
        style={{
          background: 'white',
          border: '1px solid #d8e1e8',
          borderRadius: '16px',
          boxShadow: '0 14px 36px rgba(39, 63, 82, 0.14)',
          margin: '0 auto',
          maxWidth: '900px',
          overflow: 'hidden'
        }}
      >
        <header style={{ background: '#243b53', color: 'white', padding: '30px 32px' }}>
          <div style={{ color: '#b9d9ee', fontSize: '13px', fontWeight: 'bold', letterSpacing: '1.4px', textTransform: 'uppercase' }}>
            Bot exhibition
          </div>
          <h1 style={{ fontSize: '32px', margin: '7px 0 8px' }}>Bot Mode</h1>
          <p style={{ color: '#dbe8f2', lineHeight: 1.5, margin: 0, maxWidth: '650px' }}>
            Build a lineup of bots with your chosen strategies, then simulate their match and compare the final standings.
          </p>
        </header>

        <div style={{ padding: '30px 32px 34px' }}>
          <fieldset style={{ border: 0, margin: '0 0 28px', padding: 0 }}>
            <legend style={{ color: '#243b53', fontSize: '18px', fontWeight: 'bold', marginBottom: '12px' }}>
              Number of bots
            </legend>
            <div style={{ display: 'flex', gap: '10px' }}>
              {[2, 3].map(count => (
                <button
                  key={count}
                  type="button"
                  aria-pressed={botCount === count}
                  disabled={isRunning}
                  onClick={() => onBotCountChange(count)}
                  style={{
                    background: botCount === count ? '#286090' : '#edf2f6',
                    border: botCount === count ? '2px solid #286090' : '2px solid #ced9e2',
                    borderRadius: '8px',
                    color: botCount === count ? 'white' : '#334e68',
                    cursor: isRunning ? 'not-allowed' : 'pointer',
                    fontSize: '16px',
                    fontWeight: 'bold',
                    minWidth: '112px',
                    padding: '11px 18px'
                  }}
                >
                  {count} bots
                </button>
              ))}
            </div>
          </fieldset>

          <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {policyVersions.map((policyVersion, index) => (
              <article
                key={`bot-mode-seat-${index + 1}`}
                style={{
                  background: '#f7fafc',
                  border: '1px solid #d8e1e8',
                  borderRadius: '10px',
                  padding: '20px'
                }}
              >
                <div style={{ alignItems: 'center', display: 'flex', gap: '10px', marginBottom: '14px' }}>
                  <span aria-hidden="true" style={{ fontSize: '26px' }}>🤖</span>
                  <div>
                    <div style={{ color: '#627d98', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>
                      Player seat {index + 1}
                    </div>
                    <strong style={{ color: '#243b53', fontSize: '18px' }}>bot{index + 1}</strong>
                  </div>
                </div>

                <label
                  htmlFor={`bot-mode-policy-${index}`}
                  style={{ color: '#334e68', display: 'block', fontSize: '13px', fontWeight: 'bold', marginBottom: '7px' }}
                >
                  Strategy
                </label>
                <select
                  id={`bot-mode-policy-${index}`}
                  disabled={isRunning}
                  value={policyVersion}
                  onChange={(event) => onPolicyChange(index, event.target.value)}
                  style={{
                    background: 'white',
                    border: '1px solid #9fb3c8',
                    borderRadius: '6px',
                    boxSizing: 'border-box',
                    color: '#243b53',
                    fontSize: '15px',
                    padding: '10px',
                    width: '100%'
                  }}
                >
                  {BOT_POLICY_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p style={{ color: '#627d98', fontSize: '13px', lineHeight: 1.45, margin: '11px 0 0' }}>
                  {BOT_POLICY_DESCRIPTIONS[policyVersion]}
                </p>
              </article>
            ))}
          </div>

          <p
            style={{
              background: '#e8f4ec',
              borderRadius: '7px',
              color: '#28623b',
              fontSize: '14px',
              margin: '22px 0',
              padding: '12px 14px'
            }}
          >
            Ready: {botCount} bots selected. Strategies may be shared. Draft picks are chosen randomly (for now).
          </p>

          {error && (
            <p
              role="alert"
              style={{
                background: '#fbe9e9',
                border: '1px solid #e5b8b8',
                borderRadius: '7px',
                color: '#8b2525',
                fontSize: '14px',
                margin: '0 0 22px',
                padding: '12px 14px'
              }}
            >
              {error}
            </p>
          )}

          <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'space-between' }}>
            <button
              type="button"
              disabled={isRunning}
              onClick={onBack}
              style={{
                background: 'white',
                border: '1px solid #9fb3c8',
                borderRadius: '7px',
                color: '#334e68',
                cursor: isRunning ? 'not-allowed' : 'pointer',
                opacity: isRunning ? 0.65 : 1,
                fontSize: '15px',
                fontWeight: 'bold',
                padding: '11px 20px'
              }}
            >
              Back to Lobby
            </button>
            <div style={{ textAlign: 'right' }}>
              <button
                type="button"
                disabled={isRunning}
                onClick={onRun}
                style={{
                  background: isRunning ? '#9fb3c8' : '#2f855a',
                  border: 'none',
                  borderRadius: '7px',
                  color: 'white',
                  cursor: isRunning ? 'wait' : 'pointer',
                  fontSize: '16px',
                  fontWeight: 'bold',
                  padding: '12px 24px'
                }}
              >
                {isRunning ? 'Running Match…' : 'Run Match'}
              </button>
              <div style={{ color: '#829ab1', fontSize: '12px', marginTop: '6px' }}>
                {isRunning ? 'The bots are playing in an isolated worker.' : 'Results usually arrive in under a few seconds.'}
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function BotModeResult({ result, onBackToLobby, onChangeLineup, onRunAgain }) {
  const standings = result.standings || result.gameResult?.standings || [];
  const winnerId = result.gameResult?.winnerId;
  const winnerName = result.gameResult?.winnerName;
  const completedNormally = result.terminated && result.gameResult;

  return (
    <main
      style={{
        background: 'linear-gradient(145deg, #eaf3fb 0%, #f8f4df 100%)',
        boxSizing: 'border-box',
        fontFamily: 'Arial, sans-serif',
        minHeight: '100vh',
        padding: '48px 20px'
      }}
    >
      <GameRulesHelp />
      <section
        style={{
          background: 'white',
          borderRadius: '16px',
          boxShadow: '0 14px 36px rgba(39, 63, 82, 0.14)',
          margin: '0 auto',
          maxWidth: '760px',
          overflow: 'hidden'
        }}
      >
        <header style={{ background: completedNormally ? '#243b53' : '#6b4f24', color: 'white', padding: '30px 32px', textAlign: 'center' }}>
          <div aria-hidden="true" style={{ fontSize: '52px' }}>{completedNormally ? '🏆' : '⏱️'}</div>
          <h1 style={{ fontSize: '32px', margin: '8px 0' }}>
            {completedNormally ? `${winnerName} wins!` : 'Simulation stopped'}
          </h1>
          <p style={{ color: '#dbe8f2', margin: 0 }}>
            {completedNormally
              ? `${result.gameResult.winningVictoryPoints} victory points`
              : 'The match reached its simulation decision limit without a winner.'}
          </p>
        </header>

        <div style={{ padding: '30px 32px 34px' }}>
          <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: '26px' }}>
            <div style={{ background: '#f1f5f8', borderRadius: '8px', padding: '14px', textAlign: 'center' }}>
              <div style={{ color: '#627d98', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Seed</div>
              <strong style={{ color: '#243b53', display: 'block', marginTop: '5px' }}>{result.randomSeed}</strong>
            </div>
            <div style={{ background: '#f1f5f8', borderRadius: '8px', padding: '14px', textAlign: 'center' }}>
              <div style={{ color: '#627d98', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Decisions</div>
              <strong style={{ color: '#243b53', display: 'block', marginTop: '5px' }}>{result.decisionCount}</strong>
            </div>
            <div style={{ background: '#f1f5f8', borderRadius: '8px', padding: '14px', textAlign: 'center' }}>
              <div style={{ color: '#627d98', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Bots</div>
              <strong style={{ color: '#243b53', display: 'block', marginTop: '5px' }}>{standings.length}</strong>
            </div>
          </div>

          <h2 style={{ borderBottom: '2px solid #d8e1e8', color: '#243b53', fontSize: '21px', margin: '0 0 14px', paddingBottom: '9px' }}>
            Final Standings
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {standings.map(standing => (
              <article
                key={standing.playerId}
                style={{
                  alignItems: 'center',
                  background: standing.playerId === winnerId ? '#fff7d6' : '#f7fafc',
                  border: standing.playerId === winnerId ? '2px solid #d9aa00' : '1px solid #d8e1e8',
                  borderRadius: '9px',
                  display: 'grid',
                  gap: '14px',
                  gridTemplateColumns: '48px 1fr auto',
                  padding: '14px 16px'
                }}
              >
                <strong style={{ color: '#486581', fontSize: '20px', textAlign: 'center' }}>#{standing.rank}</strong>
                <div>
                  <strong style={{ color: '#243b53' }}>🤖 {standing.name}</strong>
                  <div style={{ color: '#486581', fontSize: '13px', marginTop: '4px' }}>
                    {BOT_POLICY_LABELS[standing.policyVersion] || standing.policyVersion || 'Unknown strategy'}
                  </div>
                  <div style={{ color: '#829ab1', fontSize: '12px', marginTop: '3px' }}>
                    {(standing.factions || []).join(' & ') || 'No factions'}
                  </div>
                </div>
                <strong style={{ color: '#a33a2b', fontSize: '18px' }}>{standing.vp} VP</strong>
              </article>
            ))}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center', marginTop: '28px' }}>
            <button
              type="button"
              onClick={onRunAgain}
              style={{ background: '#2f855a', border: 0, borderRadius: '7px', color: 'white', cursor: 'pointer', fontSize: '15px', fontWeight: 'bold', padding: '11px 18px' }}
            >
              Run Same Lineup Again
            </button>
            <button
              type="button"
              onClick={onChangeLineup}
              style={{ background: '#286090', border: 0, borderRadius: '7px', color: 'white', cursor: 'pointer', fontSize: '15px', fontWeight: 'bold', padding: '11px 18px' }}
            >
              Change Lineup
            </button>
            <button
              type="button"
              onClick={onBackToLobby}
              style={{ background: 'white', border: '1px solid #9fb3c8', borderRadius: '7px', color: '#334e68', cursor: 'pointer', fontSize: '15px', fontWeight: 'bold', padding: '11px 18px' }}
            >
              Back to Lobby
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

function App() {
  // Room and lobby state
  const [playerName, setPlayerName] = useState('');
  const [roomIdInput, setRoomIdInput] = useState('');
  const [currentRoom, setCurrentRoom] = useState(null);
  const [players, setPlayers] = useState([]);
  const [spectators, setSpectators] = useState([]);
  const [isHost, setIsHost] = useState(false);
  const [hostId, setHostId] = useState(null);
  const [isSpectator, setIsSpectator] = useState(false);

  // Game state
  const [gamePhase, setGamePhase] = useState('lobby');
  const [draftState, setDraftState] = useState(null);
  const [activeBases, setActiveBases] = useState([]);
  const [currentTurnPlayerId, setCurrentTurnPlayerId] = useState(null);
  const [turnState, setTurnState] = useState(DEFAULT_TURN_STATE);
  const [battleLog, setBattleLog] = useState([]);
  const [gameResult, setGameResult] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [myHand, setMyHand] = useState([]);
  const [myDiscard, setMyDiscard] = useState([]);

  // UI state
  const [selectedCardDetail, setSelectedCardDetail] = useState(null);
  const [selectedCardToPlay, setSelectedCardToPlay] = useState(null);
  const [selectedCardSource, setSelectedCardSource] = useState('hand');
  const [targetingMode, setTargetingMode] = useState(null);
  const [showDiscardModal, setShowDiscardModal] = useState(false);
  const [abilityChoice, setAbilityChoice] = useState(null);
  const [selectedAbilityChoiceIds, setSelectedAbilityChoiceIds] = useState([]);
  const [chatDraft, setChatDraft] = useState('');
  const [selectedBotPolicy, setSelectedBotPolicy] = useState('greedy_heuristic_1');
  const [showBotModeSetup, setShowBotModeSetup] = useState(false);
  const [botModePolicyVersions, setBotModePolicyVersions] = useState(DEFAULT_BOT_MODE_POLICIES);
  const [botModeRunning, setBotModeRunning] = useState(false);
  const [botModeResult, setBotModeResult] = useState(null);
  const [botModeError, setBotModeError] = useState('');
  const chatScrollRef = useRef(null);

  useEffect(() => {
    socket.on('room-created', ({ roomId, players, spectators, host }) => {
      setCurrentRoom(roomId);
      setPlayers(players);
      setSpectators(spectators || []);
      setIsHost(host === socket.id);
      setHostId(host);
      setIsSpectator(false);
    });

    socket.on('room-joined', ({ roomId, players, spectators, host, role }) => {
      setCurrentRoom(roomId);
      setPlayers(players);
      if (spectators) setSpectators(spectators);
      setIsHost(host === socket.id);
      setHostId(host);
      setIsSpectator(role === 'spectator');
    });

    socket.on('spectate-started', ({
      roomId,
      players,
      activeBases,
      spectators,
      gamePhase,
      draftState,
      currentTurnPlayerId,
      turnState,
      battleLog,
      gameResult
    }) => {
      setCurrentRoom(roomId);
      setPlayers(players);
      if (activeBases) setActiveBases(activeBases);
      if (spectators) setSpectators(spectators);
      if (draftState) setDraftState(draftState);
      if (currentTurnPlayerId) setCurrentTurnPlayerId(currentTurnPlayerId);
      if (turnState) setTurnState(turnState);
      if (battleLog) setBattleLog(battleLog);
      if (gameResult) setGameResult(gameResult);
      setIsHost(false);
      setIsSpectator(true);
      setGamePhase(gamePhase || 'playing');
    });

    socket.on('update-players', ({ players, spectators, host }) => {
      if (players) setPlayers(players);
      if (spectators) {
        setSpectators(spectators);
        setIsSpectator(spectators.some(spectator => spectator.id === socket.id));
      }
      if (host !== undefined) {
        setIsHost(host === socket.id);
        setHostId(host);
      }
    });

    socket.on('draft-started', ({ roomId, draftState, players, spectators }) => {
      if (roomId) setCurrentRoom(roomId);
      setGamePhase('drafting');
      setDraftState(draftState);
      setPlayers(players);
      if (spectators) {
        setSpectators(spectators);
        setIsSpectator(spectators.some(spectator => spectator.id === socket.id));
      }
    });

    socket.on('draft-update', ({ draftState }) => {
      setDraftState(draftState);
    });

    socket.on('game-started', ({ roomId, players, activeBases, spectators, currentTurnPlayerId, turnState, gamePhase, battleLog, gameResult }) => {
      if (roomId) setCurrentRoom(roomId);
      setGamePhase(gamePhase || 'playing');
      setPlayers(players);
      if (activeBases) setActiveBases(activeBases);
      if (spectators) {
        setSpectators(spectators);
        setIsSpectator(spectators.some(spectator => spectator.id === socket.id));
      }
      if (currentTurnPlayerId) setCurrentTurnPlayerId(currentTurnPlayerId);
      if (turnState) setTurnState(turnState);
      if (battleLog) setBattleLog(battleLog);
      if (gameResult) setGameResult(gameResult);

      const me = players.find(p => p.id === socket.id);
      if (me) {
        if (me.hand) setMyHand(me.hand);
        if (me.discardPile) setMyDiscard(me.discardPile);
      }
    });

    socket.on('game-state-update', ({ players, activeBases, currentTurnPlayerId, turnState, spectators, gamePhase, battleLog, gameResult }) => {
      if (gamePhase) setGamePhase(gamePhase);
      setPlayers(players);
      if (activeBases) setActiveBases(activeBases);
      if (currentTurnPlayerId !== undefined) setCurrentTurnPlayerId(currentTurnPlayerId);
      if (turnState) setTurnState(turnState);
      if (spectators) {
        setSpectators(spectators);
        setIsSpectator(spectators.some(spectator => spectator.id === socket.id));
      }
      if (battleLog) setBattleLog(battleLog);
      if (gameResult) setGameResult(gameResult);

      const me = players.find(p => p.id === socket.id);
      if (me) {
        if (me.hand) setMyHand(me.hand);
        if (me.discardPile) setMyDiscard(me.discardPile);
      }
    });

    socket.on('ability-choice-required', (choiceRequest) => {
      setAbilityChoice(choiceRequest);
      setSelectedAbilityChoiceIds([]);
    });

    socket.on('chat-history', ({ messages }) => {
      setChatMessages(Array.isArray(messages) ? messages : []);
    });

    socket.on('chat-message', (message) => {
      setChatMessages(current => (
        current.some(existing => existing.id === message.id)
          ? current
          : [...current, message]
      ));
    });

    socket.on('bot-match-completed', (result) => {
      setBotModeRunning(false);
      setBotModeError('');
      setBotModeResult(result);
    });

    socket.on('bot-match-failed', ({ error } = {}) => {
      setBotModeRunning(false);
      setBotModeError(error || 'The bot match could not be completed.');
    });

    const handleSocketDisconnect = () => {
      setBotModeRunning(wasRunning => {
        if (wasRunning) setBotModeError('The server connection was lost while the bots were playing.');
        return false;
      });
    };
    socket.on('disconnect', handleSocketDisconnect);

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
      socket.off('ability-choice-required');
      socket.off('chat-history');
      socket.off('chat-message');
      socket.off('bot-match-completed');
      socket.off('bot-match-failed');
      socket.off('disconnect', handleSocketDisconnect);
      socket.off('room-reset');
      socket.off('error');
    };
  }, []);

  useEffect(() => {
    const chatElement = chatScrollRef.current;
    if (chatElement) chatElement.scrollTop = chatElement.scrollHeight;
  }, [chatMessages, gamePhase]);

  const resetAppToLobby = () => {
    setCurrentRoom(null);
    setPlayers([]);
    setSpectators([]);
    setIsHost(false);
    setHostId(null);
    setIsSpectator(false);
    setGamePhase('lobby');
    setDraftState(null);
    setRoomIdInput('');
    setMyHand([]);
    setMyDiscard([]);
    setActiveBases([]);
    setCurrentTurnPlayerId(null);
    setTurnState(DEFAULT_TURN_STATE);
    setBattleLog([]);
    setGameResult(null);
    setChatMessages([]);
    setChatDraft('');
    setSelectedCardDetail(null);
    setSelectedCardToPlay(null);
    setSelectedCardSource('hand');
    setTargetingMode(null);
    setShowDiscardModal(false);
    setAbilityChoice(null);
    setSelectedAbilityChoiceIds([]);
    setShowBotModeSetup(false);
    setBotModeRunning(false);
    setBotModeResult(null);
    setBotModeError('');
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

  const handleAddBot = () => {
    socket.emit('add-bot', { roomId: currentRoom, policyVersion: selectedBotPolicy });
  };

  const handleRemoveBot = (botId) => {
    socket.emit('remove-bot', { roomId: currentRoom, botId });
  };

  const handleBotModeCountChange = (botCount) => {
    setBotModePolicyVersions(currentPolicies => {
      const nextPolicies = currentPolicies.slice(0, botCount);
      while (nextPolicies.length < botCount) {
        const availablePolicy = BOT_POLICY_OPTIONS.find(option => !nextPolicies.includes(option.value));
        nextPolicies.push(availablePolicy.value);
      }
      return nextPolicies;
    });
  };

  const handleBotModePolicyChange = (botIndex, policyVersion) => {
    setBotModePolicyVersions(currentPolicies => currentPolicies.map((currentPolicy, index) => (
      index === botIndex ? policyVersion : currentPolicy
    )));
  };

  const handleRunBotModeMatch = () => {
    if (!socket.connected) {
      setBotModeError('The server is not connected. Please try again when the connection returns.');
      return;
    }
    setBotModeRunning(true);
    setBotModeResult(null);
    setBotModeError('');
    socket.emit('run-bot-match', { policyVersions: botModePolicyVersions });
  };

  const handleCloseBotMode = () => {
    setShowBotModeSetup(false);
    setBotModeResult(null);
    setBotModeError('');
  };

  const handleDraftFaction = (factionName) => {
    socket.emit('draft-faction', { roomId: currentRoom, factionName });
  };

  const handlePlayCard = (cardInstanceId, baseIndex = null, targetMinionInstanceId = null, fromDiscard = false) => {
    socket.emit('play-card', { roomId: currentRoom, cardInstanceId, baseIndex, targetMinionInstanceId, fromDiscard });
  };

  const handleAbilityChoice = (choice) => {
    socket.emit('resolve-ability-choice', { roomId: currentRoom, choice });
    setAbilityChoice(null);
    setSelectedAbilityChoiceIds([]);
  };

  const toggleAbilityChoice = (choiceId) => {
    setSelectedAbilityChoiceIds(current => (
      current.includes(choiceId)
        ? current.filter(id => id !== choiceId)
        : current.length < (abilityChoice.maxSelections ?? Infinity)
          ? [...current, choiceId]
          : current
    ));
  };

  const handleBatchAbilityChoice = () => {
    const selectedChoices = abilityChoice.selectionMode === 'ordered'
      ? selectedAbilityChoiceIds.map(choiceId => abilityChoice.choices.find(choice => choice.choiceId === choiceId))
      : abilityChoice.choices.filter(choice => selectedAbilityChoiceIds.includes(choice.choiceId));
    handleAbilityChoice({
      choiceIds: selectedAbilityChoiceIds,
      cardInstanceIds: selectedChoices.map(choice => choice?.cardInstanceId).filter(Boolean),
      minionInstanceIds: selectedChoices.map(choice => choice?.minionInstanceId).filter(Boolean)
    });
  };

  const handleEndTurn = () => {
    socket.emit('end-turn', { roomId: currentRoom });
  };

  const handleSendChatMessage = (event) => {
    event.preventDefault();
    const message = chatDraft.trim();
    if (!message || !currentRoom) return;
    socket.emit('send-chat-message', { roomId: currentRoom, message });
    setChatDraft('');
  };

  const handleLeaveRoom = () => {
    if (currentRoom) {
      socket.emit('leave-room', { roomId: currentRoom });
    }
    resetAppToLobby();
  };

  if (!currentRoom && showBotModeSetup) {
    if (botModeResult) {
      return (
        <BotModeResult
          result={botModeResult}
          onBackToLobby={handleCloseBotMode}
          onChangeLineup={() => setBotModeResult(null)}
          onRunAgain={handleRunBotModeMatch}
        />
      );
    }
    return (
      <BotModeSetup
        botCount={botModePolicyVersions.length}
        error={botModeError}
        isRunning={botModeRunning}
        policyVersions={botModePolicyVersions}
        onBack={handleCloseBotMode}
        onBotCountChange={handleBotModeCountChange}
        onPolicyChange={handleBotModePolicyChange}
        onRun={handleRunBotModeMatch}
      />
    );
  }

  if (gamePhase === 'finished') {
    const standings = gameResult?.standings || [...players]
      .sort((left, right) => (right.vp || 0) - (left.vp || 0))
      .map((player, index) => ({
        rank: index + 1,
        playerId: player.id,
        name: player.name,
        vp: player.vp || 0,
        factions: player.factions || [],
        isBot: player.isBot === true
      }));

    return (
      <div style={{ minHeight: '100vh', padding: '50px 20px', boxSizing: 'border-box', fontFamily: 'Arial, sans-serif', background: 'linear-gradient(135deg, #f8f4df, #dceeff)' }}>
        <div style={{ maxWidth: '720px', margin: '0 auto', background: 'white', borderRadius: '14px', padding: '32px', boxShadow: '0 10px 30px rgba(0,0,0,0.15)' }}>
          <div style={{ textAlign: 'center', marginBottom: '28px' }}>
            <div style={{ fontSize: '54px' }}>🏆</div>
            <h1 style={{ margin: '8px 0', color: '#2c3e50' }}>Game Over</h1>
            <h2 style={{ margin: 0, color: '#b8860b' }}>
              {gameResult?.winnerName || standings[0]?.name || 'The winner'} wins!
            </h2>
            <p style={{ color: '#555' }}>
              Room {currentRoom} · {gameResult?.winningVictoryPoints ?? standings[0]?.vp ?? 0} victory points
            </p>
          </div>

          <h3 style={{ borderBottom: '2px solid #ddd', paddingBottom: '8px' }}>Final Standings</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {standings.map(standing => (
              <div
                key={standing.playerId}
                style={{ display: 'grid', gridTemplateColumns: '55px 1fr auto', gap: '12px', alignItems: 'center', padding: '14px', borderRadius: '8px', background: standing.playerId === gameResult?.winnerId ? '#fff3bf' : '#f4f4f4', border: standing.playerId === gameResult?.winnerId ? '2px solid #e0b400' : '1px solid #ddd' }}
              >
                <strong style={{ fontSize: '20px', textAlign: 'center' }}>#{standing.rank}</strong>
                <div>
                  <strong>{standing.name}</strong>
                  {standing.playerId === socket.id ? ' (You)' : ''}
                  {standing.isBot ? ' 🤖' : ''}
                  <div style={{ color: '#666', fontSize: '12px', marginTop: '3px' }}>
                    {(standing.factions || []).join(' & ') || 'No factions'}
                  </div>
                </div>
                <strong style={{ color: '#b33', fontSize: '18px' }}>{standing.vp} VP</strong>
              </div>
            ))}
          </div>

          <button
            onClick={handleLeaveRoom}
            style={{ display: 'block', margin: '28px auto 0', padding: '11px 22px', border: 'none', borderRadius: '6px', background: '#286090', color: 'white', fontSize: '16px', cursor: 'pointer' }}
          >
            Return to Lobby
          </button>
        </div>
      </div>
    );
  }

  // --- 1. SPECTATOR SCREEN ---
  if (isSpectator && (gamePhase === 'playing' || gamePhase === 'scoring')) {
    return (
      <div style={{ padding: '30px', fontFamily: 'Arial, sans-serif' }}>
        <GameRulesHelp />
        <h1>Smash Up - Spectator Mode 👀</h1>
        <h2>Room Code: <span style={{ color: 'blue' }}>{currentRoom}</span></h2>
        <p><em>You are spectating this match live.</em></p>

        <div style={{ display: 'flex', gap: '30px' }}>
          <div style={{ flex: '1', background: '#f4f4f4', padding: '15px', borderRadius: '8px', minWidth: '240px' }}>
            <h3>Players in Match:</h3>
            <ul>
              {players.map((p, index) => (
                <li key={index} style={{ marginBottom: '10px' }}>
                  <strong>{getPlayerDisplayName(p)}</strong> {p.id === currentTurnPlayerId ? '⭐ (Active Turn)' : ''}
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
        <GameRulesHelp />
        <h1>Smash Up - Faction Draft Phase</h1>
        <h2>Room Code: <span style={{ color: 'blue' }}>{currentRoom}</span></h2>

        <div style={{ display: 'flex', gap: '30px' }}>
          <div style={{ flex: '3' }}>
            <div style={{ background: isMyTurn ? '#d4edda' : '#fff3cd', padding: '15px', borderRadius: '6px', marginBottom: '20px' }}>
              <h3>
                {isSpectator
                  ? `👀 Spectating — ${currentPicker?.name || 'a player'} is picking...`
                  : isMyTurn
                    ? "👉 It's Your Turn to Pick a Faction!"
                    : `⏳ Waiting for ${currentPicker?.name || 'someone'} to pick...`}
              </h3>
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
                  <strong>{getPlayerDisplayName(p)} {p.id === socket.id ? '(You)' : ''}:</strong>{' '}
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
    const requiredExtraMinionPlay = turnState.extraMinionPlays?.find(permission => permission.required);
    const discardPlayBaseIndices = turnState.ongoingDiscardMinionPlayed
      ? []
      : activeBases
        .map((base, baseIndex) => ({ base, baseIndex }))
        .filter(({ base }) => (base.playedCards || []).some(card => (
          card.type === 'action'
          && card.ownerId === socket.id
          && (card.abilities || []).some(ability => (
            ability.trigger === 'ongoing'
            && (ability.effects || []).some(effect => (
              effect.type === 'grantDiscardPlayPermission'
              && effect.cardType === 'minion'
              && effect.destination === 'attachedBase'
            ))
          ))
        )))
        .map(({ baseIndex }) => baseIndex);
    const targetBaseOptions = activeBases
      .map((base, baseIndex) => ({ base, baseIndex }))
      .filter(({ baseIndex }) => selectedCardSource !== 'discard' || discardPlayBaseIndices.includes(baseIndex))
      .filter(({ baseIndex }) => (
        !requiredExtraMinionPlay
        || (selectedCardSource === 'hand' && baseIndex === requiredExtraMinionPlay.allowedBaseIndex)
      ));

    return (
      <div style={{ padding: '30px', fontFamily: 'Arial, sans-serif' }}>
        <GameRulesHelp />
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
              Action Played: {turnState.actionPlayed ? '✅ (1/1)' : '❌ (0/1)'}
              {turnState.extraActionPlays > 0 ? ` + ${turnState.extraActionPlays} extra` : ''}
              {' | '}
              Minion Played: {turnState.minionPlayed ? '✅ (1/1)' : '❌ (0/1)'}
              {turnState.extraMinionPlays?.length > 0 ? ` + ${turnState.extraMinionPlays.length} extra` : ''}
            </div>
            {requiredExtraMinionPlay && (
              <div style={{ fontSize: '12px', marginTop: '5px', color: '#a15c00', fontWeight: 'bold' }}>
                Play the Talent's extra minion at {activeBases[requiredExtraMinionPlay.allowedBaseIndex]?.name} now.
              </div>
            )}
          </div>
          {isMyTurn && gamePhase === 'playing' && (
            <button
              onClick={handleEndTurn}
              disabled={Boolean(requiredExtraMinionPlay)}
              style={{
                padding: '10px 20px',
                backgroundColor: requiredExtraMinionPlay ? '#999' : '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontWeight: 'bold',
                cursor: requiredExtraMinionPlay ? 'not-allowed' : 'pointer',
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
                      <strong>{getPlayerDisplayName(p)}</strong> {isMe ? '(You)' : ''} {p.id === currentTurnPlayerId ? '⭐' : ''}
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
                      <li key={idx} style={{ fontSize: '11px', lineHeight: '1.3', whiteSpace: 'pre-wrap' }}>
                        <BattleLogEntry entry={log} onCardClick={setSelectedCardDetail} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Player chat */}
            <div style={{ borderTop: '1px solid #ddd', paddingTop: '10px' }}>
              <h3 style={{ margin: '0 0 8px 0', fontSize: '15px' }}>Player Chat</h3>
              <div
                ref={chatScrollRef}
                style={{
                  border: '1px solid #ccc',
                  borderRadius: '6px',
                  padding: '10px',
                  backgroundColor: '#fff',
                  height: '180px',
                  overflowY: 'auto'
                }}
              >
                {chatMessages.length === 0 ? (
                  <p style={{ fontSize: '11px', color: '#777', fontStyle: 'italic', margin: 0 }}>
                    No messages yet.
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {chatMessages.map(message => (
                      <div key={message.id} style={{ fontSize: '11px', lineHeight: '1.35' }}>
                        <div>
                          <strong style={{ color: message.senderId === socket.id ? '#007bff' : '#333' }}>
                            {message.senderName}
                          </strong>
                          <span style={{ color: '#999', marginLeft: '6px', fontSize: '9px' }}>
                            {new Date(message.timestamp).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit'
                            })}
                          </span>
                        </div>
                        <div style={{ color: '#444', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                          {message.text}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <form
                onSubmit={handleSendChatMessage}
                style={{ display: 'flex', gap: '6px', marginTop: '8px' }}
              >
                <input
                  type="text"
                  value={chatDraft}
                  onChange={(event) => setChatDraft(event.target.value)}
                  maxLength={500}
                  placeholder="Message players..."
                  aria-label="Chat message"
                  style={{
                    border: '1px solid #bbb',
                    borderRadius: '4px',
                    flex: 1,
                    fontSize: '11px',
                    minWidth: 0,
                    padding: '7px'
                  }}
                />
                <button
                  type="submit"
                  disabled={!chatDraft.trim()}
                  style={{
                    backgroundColor: chatDraft.trim() ? '#007bff' : '#aaa',
                    border: 'none',
                    borderRadius: '4px',
                    color: 'white',
                    cursor: chatDraft.trim() ? 'pointer' : 'not-allowed',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    padding: '7px 10px'
                  }}
                >
                  Send
                </button>
              </form>
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
                              const talent = (minion.abilities || []).find(ability => ability.trigger === 'talent');
                              const talentUseKey = `${minion.instanceId}:talent`;
                              const talentUsed = Boolean(turnState.talentUses?.[talentUseKey]);
                              const talentConditionMet = Object.entries(talent?.condition?.turnState || {})
                                .every(([key, expectedValue]) => turnState[key] === expectedValue);
                              const canUseTalent = isMyTurn
                                && gamePhase === 'playing'
                                && minion.ownerId === socket.id
                                && !talentUsed
                                && talentConditionMet
                                && !abilityChoice
                                && !requiredExtraMinionPlay;

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

                                  {talent && minion.ownerId === socket.id && (
                                    <button
                                      type="button"
                                      onClick={() => socket.emit('use-talent', {
                                        roomId: currentRoom,
                                        cardInstanceId: minion.instanceId
                                      })}
                                      disabled={!canUseTalent}
                                      style={{
                                        backgroundColor: canUseTalent ? '#6f42c1' : '#aaa',
                                        border: 'none',
                                        borderRadius: '4px',
                                        color: 'white',
                                        cursor: canUseTalent ? 'pointer' : 'not-allowed',
                                        fontSize: '10px',
                                        fontWeight: 'bold',
                                        marginTop: '5px',
                                        padding: '5px 7px',
                                        width: '100%'
                                      }}
                                    >
                                      {talentUsed ? 'Talent Used' : talentConditionMet ? 'Use Talent' : 'Talent Unavailable'}
                                    </button>
                                  )}

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
                        disabled={Boolean(requiredExtraMinionPlay && card.type !== 'minion')}
                        onClick={() => {
                          if (card.subtype === 'base') {
                            setSelectedCardToPlay(card);
                            setSelectedCardSource('hand');
                            setTargetingMode('base');
                          } else if (MINION_TARGETING_MODES.includes(card.subtype)) {
                            setSelectedCardToPlay(card);
                            setSelectedCardSource('hand');
                            setTargetingMode(card.subtype);
                          } else {
                            handlePlayCard(card.instanceId);
                          }
                        }}
                        style={{
                          fontSize: '11px',
                          padding: '6px 12px',
                          backgroundColor: requiredExtraMinionPlay && card.type !== 'minion' ? '#999' : '#007bff',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: requiredExtraMinionPlay && card.type !== 'minion' ? 'not-allowed' : 'pointer',
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
                            {card.type === 'minion'
                              && isMyTurn
                              && gamePhase === 'playing'
                              && !requiredExtraMinionPlay
                              && discardPlayBaseIndices.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedCardToPlay(card);
                                    setSelectedCardSource('discard');
                                    setTargetingMode('base');
                                    setShowDiscardModal(false);
                                  }}
                                  style={{
                                    backgroundColor: '#6f42c1',
                                    border: 'none',
                                    borderRadius: '4px',
                                    color: 'white',
                                    cursor: 'pointer',
                                    fontSize: '10px',
                                    fontWeight: 'bold',
                                    marginTop: '8px',
                                    padding: '6px',
                                    width: '100%'
                                  }}
                                >
                                  Play from Discard
                                </button>
                              )}
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
                      {selectedCardDetail.type} {(selectedCardDetail.printedPower ?? selectedCardDetail.power) !== undefined
                        ? `• Power: ${selectedCardDetail.printedPower ?? selectedCardDetail.power}`
                        : ''}
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
                    maxHeight: '85vh',
                    overflowY: 'auto',
                    boxSizing: 'border-box',
                    boxShadow: '0 5px 15px rgba(0,0,0,0.3)',
                    textAlign: 'center'
                  }}>
                    <h3 style={{ marginTop: 0 }}>
                      {selectedCardSource === 'discard' ? 'Play from discard' : 'Play'} "{selectedCardToPlay.name}"
                    </h3>

                    {targetingMode === 'base' && (
                      <>
                        <p style={{ fontSize: '13px', color: '#555' }}>Select a base to target:</p>
                        <div style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '10px',
                          margin: '20px 0',
                          maxHeight: '50vh',
                          overflowY: 'auto'
                        }}>
                          {targetBaseOptions.map(({ base, baseIndex: bIdx }) => (
                            <button
                              key={bIdx}
                              onClick={() => {
                                handlePlayCard(
                                  selectedCardToPlay.instanceId,
                                  bIdx,
                                  null,
                                  selectedCardSource === 'discard'
                                );
                                setSelectedCardToPlay(null);
                                setSelectedCardSource('hand');
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
                                    setSelectedCardSource('hand');
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
                        setSelectedCardSource('hand');
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

              {abilityChoice && (
                <div
                  style={{
                    position: 'fixed',
                    inset: 0,
                    backgroundColor: 'rgba(0, 0, 0, 0.6)',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    zIndex: 3000
                  }}
                >
                  <div
                    style={{
                      background: 'white',
                      borderRadius: '10px',
                      boxShadow: '0 5px 15px rgba(0,0,0,0.3)',
                      maxWidth: '420px',
                      maxHeight: '85vh',
                      overflowY: 'auto',
                      boxSizing: 'border-box',
                      padding: '30px',
                      textAlign: 'center',
                      width: '100%'
                    }}
                  >
                    <h3 style={{ marginTop: 0 }}>Resolve Ability</h3>
                    <p style={{ color: '#555', fontSize: '14px' }}>{abilityChoice.message}</p>
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px',
                      marginTop: '20px',
                      maxHeight: '50vh',
                      overflowY: 'auto'
                    }}>
                      {abilityChoice.choices.map((choice) => (
                        <button
                          key={choice.choiceId || choice.minionInstanceId}
                          onClick={() => abilityChoice.selectionMode === 'multiple' || abilityChoice.selectionMode === 'ordered'
                            ? toggleAbilityChoice(choice.choiceId)
                            : handleAbilityChoice(choice)}
                          style={{
                            backgroundColor: selectedAbilityChoiceIds.includes(choice.choiceId) ? '#28a745' : '#6f42c1',
                            border: selectedAbilityChoiceIds.includes(choice.choiceId) ? '3px solid #155724' : '3px solid transparent',
                            borderRadius: '6px',
                            color: 'white',
                            cursor: 'pointer',
                            fontSize: '14px',
                            fontWeight: 'bold',
                            padding: '12px'
                          }}
                        >
                          {abilityChoice.selectionMode === 'ordered' && selectedAbilityChoiceIds.includes(choice.choiceId)
                            ? `${selectedAbilityChoiceIds.indexOf(choice.choiceId) + 1}. ${choice.label}`
                            : choice.label}
                        </button>
                      ))}
                      {(abilityChoice.selectionMode === 'multiple' || abilityChoice.selectionMode === 'ordered') ? (
                        <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                          <button
                            onClick={handleBatchAbilityChoice}
                            disabled={selectedAbilityChoiceIds.length < (abilityChoice.minSelections || 0)}
                            style={{
                              backgroundColor: '#28a745',
                              border: 'none',
                              borderRadius: '6px',
                              color: 'white',
                              cursor: 'pointer',
                              flex: 1,
                              fontSize: '14px',
                              fontWeight: 'bold',
                              padding: '12px'
                            }}
                          >
                            {abilityChoice.selectionMode === 'ordered'
                              ? `Confirm Order (${selectedAbilityChoiceIds.length}/${abilityChoice.maxSelections})`
                              : `Use Ability (${selectedAbilityChoiceIds.length} selected)`}
                          </button>
                          {abilityChoice.canSkip && (
                            <button
                              onClick={() => handleAbilityChoice({ cancel: true })}
                              style={{
                                backgroundColor: '#6c757d',
                                border: 'none',
                                borderRadius: '6px',
                                color: 'white',
                                cursor: 'pointer',
                                flex: 1,
                                fontSize: '14px',
                                padding: '12px'
                              }}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      ) : abilityChoice.canSkip && (
                        <button
                          onClick={() => handleAbilityChoice({ skip: true })}
                          style={{
                            backgroundColor: '#6c757d',
                            border: 'none',
                            borderRadius: '6px',
                            color: 'white',
                            cursor: 'pointer',
                            fontSize: '14px',
                            padding: '12px'
                          }}
                        >
                          Done
                        </button>
                      )}
                    </div>
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
      <GameRulesHelp />
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

          <div style={{ marginBottom: '18px' }}>
            <button
              type="button"
              onClick={() => {
                setBotModeResult(null);
                setBotModeError('');
                setShowBotModeSetup(true);
              }}
              style={{
                background: '#243b53',
                border: 'none',
                borderRadius: '5px',
                color: 'white',
                cursor: 'pointer',
                fontWeight: 'bold',
                padding: '10px 18px'
              }}
            >
              Open Bot Mode
            </button>
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
              <li key={p.id || index}>
                {p.name} {p.id === socket.id ? '(You)' : ''}
                {p.isBot ? ` 🤖 (Bot: ${BOT_POLICY_LABELS[p.policyVersion] || 'Random'})` : ''}
                {p.id === hostId ? ' 👑 (Host)' : ''}
                {isHost && p.isBot && (
                  <button
                    onClick={() => handleRemoveBot(p.id)}
                    style={{ marginLeft: '10px', padding: '3px 8px', backgroundColor: '#d9534f', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer' }}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>

          <h3>Spectators ({spectators.length}):</h3>
          {spectators.length === 0 ? (
            <p style={{ color: '#777', fontSize: '13px', fontStyle: 'italic' }}>No spectators</p>
          ) : (
            <ul>
              {spectators.map((spectator) => (
                <li key={spectator.id}>
                  👁️ {spectator.name} {spectator.id === socket.id ? '(You)' : ''}
                </li>
              ))}
            </ul>
          )}

          {isHost ? (
            <div style={{ marginTop: '20px' }}>
              {players.length < 4 && (
                <>
                  <label style={{ marginRight: '8px' }} htmlFor="bot-policy">Bot strategy:</label>
                  <select
                    id="bot-policy"
                    value={selectedBotPolicy}
                    onChange={(event) => setSelectedBotPolicy(event.target.value)}
                    style={{ marginRight: '8px', padding: '9px' }}
                  >
                    {BOT_POLICY_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <button
                    onClick={handleAddBot}
                    style={{ padding: '10px 20px', fontSize: '16px', backgroundColor: '#286090', color: 'white', cursor: 'pointer', marginRight: '10px' }}
                  >
                    Add Bot
                  </button>
                </>
              )}
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
              <p>
                <em>
                  {isSpectator
                    ? 'This lobby already has four players. You will spectate the draft and match.'
                    : 'Waiting for the host to start the game...'}
                </em>
              </p>
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
