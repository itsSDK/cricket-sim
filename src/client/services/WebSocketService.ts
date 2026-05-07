import { ClientMessage, ServerMessage, SessionState, Role } from '../../shared/types';

type MessageHandler = (msg: ServerMessage) => void;

export class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Set<MessageHandler> = new Set();
  private reconnectTimer: number | null = null;
  private isIntentionalDisconnect = false;
  
  public isConnected = false;
  private pinger: number | null = null;

  constructor(private sessionId: string, private role: Role) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // When running locally with wrangler dev, the host is usually the same
    this.url = `${protocol}//${window.location.host}/ws/session/${sessionId}`;
  }

  connect() {
    if (this.ws) return;
    this.isIntentionalDisconnect = false;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.isConnected = true;
      console.log('WS Connected');
      this.send({ type: 'JOIN', role: this.role, sessionId: this.sessionId });
      
      // Ping every 20 seconds to keep DO awake/connection alive
      this.pinger = window.setInterval(() => {
        this.send({ type: 'PING' });
      }, 20000);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        this.handlers.forEach(h => h(msg));
      } catch (e) {
        console.error('Failed to parse message', e);
      }
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      this.ws = null;
      if (this.pinger) clearInterval(this.pinger);
      
      if (!this.isIntentionalDisconnect) {
        // Exponential backoff or simple fixed backoff
        this.reconnectTimer = window.setTimeout(() => this.connect(), 3000);
      }
    };

    this.ws.onerror = (err) => {
      console.error('WS Error', err);
    };
  }

  disconnect() {
    this.isIntentionalDisconnect = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pinger) clearInterval(this.pinger);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.warn('WebSocket not open, could not send:', msg);
    }
  }

  onMessage(handler: MessageHandler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
