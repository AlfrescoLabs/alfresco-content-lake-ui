import { Injectable } from '@angular/core';
import { AuthenticationService } from '@alfresco/adf-core';
import { Observable, Subject } from 'rxjs';

import { ChatMessage } from '../models/rag.models';

interface RagChatSessionRecord {
  sessionId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages: ChatMessage[];
}

interface StoredRagChatSessionRecord {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredChatMessage[];
}

interface RagChatSessionState {
  activeSessionId: string | null;
  sessions: RagChatSessionRecord[];
}

interface StoredRagChatSessionState {
  activeSessionId: string | null;
  sessions: StoredRagChatSessionRecord[];
}

interface StoredChatMessage extends Omit<ChatMessage, 'timestamp'> {
  timestamp: string;
}

export interface RagChatSessionSummary {
  sessionId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
}

/**
 * Persists chat sessions for the extension so state survives route changes.
 *
 * State is kept in memory and mirrored to sessionStorage under a key that names the
 * signed-in user. ACA signs out without reloading the page and sessionStorage outlives
 * the session, so the store is bound to one user: it is wiped on logout, and any read or
 * write made under a different user than the one it was loaded for discards it first.
 */
@Injectable({ providedIn: 'root' })
export class RagChatSessionService {

  private static readonly STORAGE_KEY_PREFIX = 'ext-rag.chat.sessions.';
  private static readonly STORAGE_KEY_VERSION = 'v2';

  private owner: string | null = null;
  private stateValue: RagChatSessionState = RagChatSessionService.emptyState();
  private readonly clearedSubject = new Subject<void>();

  /** Emits when the store is discarded because the user signed out or changed. */
  readonly cleared$: Observable<void> = this.clearedSubject.asObservable();

  constructor(private auth: AuthenticationService) {
    this.syncOwner();
    this.auth.onLogout.subscribe(() => this.clear());
  }

  ensureActiveSession(): string {
    const current = this.state().activeSessionId;
    if (current && this.findSession(current)) {
      return current;
    }

    if (this.state().sessions.length > 0) {
      this.state().activeSessionId = this.state().sessions[0].sessionId;
      this.persist();
      return this.state().activeSessionId;
    }

    return this.createSession();
  }

  createSession(): string {
    const now = new Date();
    const sessionId = this.generateSessionId();
    const session: RagChatSessionRecord = {
      sessionId,
      title: 'New conversation',
      createdAt: now,
      updatedAt: now,
      messages: []
    };

    this.state().sessions = [session, ...this.state().sessions];
    this.state().activeSessionId = sessionId;
    this.persist();
    return sessionId;
  }

  activateSession(sessionId: string): void {
    if (!this.findSession(sessionId)) {
      return;
    }
    this.state().activeSessionId = sessionId;
    this.persist();
  }

  /**
   * Migrates an existing session record to the id assigned by the backend.
   *
   * The chat starts under a UI-generated id; when the backend returns its own
   * sessionId the record must be renamed in place, otherwise the next save
   * creates a second (orphaned) session for the same conversation.
   */
  renameSession(oldSessionId: string, newSessionId: string): void {
    if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) {
      this.state().activeSessionId = newSessionId || this.state().activeSessionId;
      return;
    }

    const session = this.findSession(oldSessionId);
    if (!session) {
      this.state().activeSessionId = newSessionId;
      this.persist();
      return;
    }

    if (this.findSession(newSessionId)) {
      // A record already exists under the backend id: drop the UI-id orphan.
      this.state().sessions = this.state().sessions.filter((s) => s.sessionId !== oldSessionId);
    } else {
      session.sessionId = newSessionId;
    }

    this.state().activeSessionId = newSessionId;
    this.persist();
  }

  deleteSession(sessionId: string): void {
    this.state().sessions = this.state().sessions.filter((s) => s.sessionId !== sessionId);
    if (this.state().activeSessionId === sessionId) {
      this.state().activeSessionId = this.state().sessions[0]?.sessionId ?? null;
    }
    this.persist();
  }

  getActiveSessionId(): string | null {
    return this.state().activeSessionId;
  }

  listSessions(): RagChatSessionSummary[] {
    return this.state().sessions.map((session) => ({
      sessionId: session.sessionId,
      title: session.title,
      createdAt: new Date(session.createdAt),
      updatedAt: new Date(session.updatedAt),
      messageCount: session.messages.length
    }));
  }

  getMessages(sessionId: string): ChatMessage[] {
    const session = this.findSession(sessionId);
    if (!session) {
      return [];
    }
    return session.messages.map((message) => ({
      ...message,
      timestamp: new Date(message.timestamp)
    }));
  }

  saveMessages(sessionId: string, messages: ChatMessage[]): void {
    const now = new Date();
    const normalizedMessages = messages.map((message) => ({
      ...message,
      timestamp: new Date(message.timestamp ?? now)
    }));
    const existing = this.findSession(sessionId);

    if (existing) {
      existing.messages = normalizedMessages;
      existing.updatedAt = this.resolveUpdatedAt(normalizedMessages, now);
      existing.title = this.resolveTitle(normalizedMessages);
    } else {
      const createdAt = this.resolveCreatedAt(normalizedMessages, now);
      this.state().sessions.push({
        sessionId,
        title: this.resolveTitle(normalizedMessages),
        createdAt,
        updatedAt: this.resolveUpdatedAt(normalizedMessages, now),
        messages: normalizedMessages
      });
    }

    this.state().sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    this.state().activeSessionId = sessionId;
    this.persist();
  }

  /** Discards every stored conversation, for every user, in memory and in sessionStorage. */
  clear(): void {
    this.owner = null;
    this.stateValue = RagChatSessionService.emptyState();
    this.removeStoredState(null);
    this.clearedSubject.next();
  }

  private state(): RagChatSessionState {
    this.syncOwner();
    return this.stateValue;
  }

  /** Reloads the store when the signed-in user is not the one it was loaded for. */
  private syncOwner(): void {
    const user = this.currentUser();
    if (user === this.owner) {
      return;
    }
    const hadOwner = this.owner !== null;
    this.owner = user;
    this.removeStoredState(user);
    this.stateValue = user ? this.loadState(user) : RagChatSessionService.emptyState();
    if (hadOwner) {
      this.clearedSubject.next();
    }
  }

  private currentUser(): string | null {
    try {
      return this.auth.isLoggedIn() ? (this.auth.getUsername()?.trim() || null) : null;
    } catch {
      return null;
    }
  }

  private storageKey(user: string): string {
    return `${RagChatSessionService.STORAGE_KEY_PREFIX}${RagChatSessionService.STORAGE_KEY_VERSION}:${user}`;
  }

  /** Removes stored chat state of every user except `keepUser`, including unowned legacy keys. */
  private removeStoredState(keepUser: string | null): void {
    if (typeof sessionStorage === 'undefined') {
      return;
    }
    const keep = keepUser ? this.storageKey(keepUser) : null;
    const stale: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith(RagChatSessionService.STORAGE_KEY_PREFIX) && key !== keep) {
        stale.push(key);
      }
    }
    stale.forEach((key) => sessionStorage.removeItem(key));
  }

  private static emptyState(): RagChatSessionState {
    return { activeSessionId: null, sessions: [] };
  }

  private findSession(sessionId: string): RagChatSessionRecord | undefined {
    return this.state().sessions.find((session) => session.sessionId === sessionId);
  }

  private resolveTitle(messages: ChatMessage[]): string {
    const firstUserTurn = messages.find((message) => message.role === 'user' && message.content?.trim());
    if (!firstUserTurn) {
      return 'New conversation';
    }

    const content = firstUserTurn.content.trim();
    return content.length > 72 ? `${content.slice(0, 69)}...` : content;
  }

  private resolveCreatedAt(messages: ChatMessage[], fallback: Date): Date {
    if (messages.length === 0) {
      return fallback;
    }

    let createdAt = new Date(messages[0].timestamp);
    for (const message of messages) {
      const ts = new Date(message.timestamp);
      if (ts.getTime() < createdAt.getTime()) {
        createdAt = ts;
      }
    }
    return createdAt;
  }

  private resolveUpdatedAt(messages: ChatMessage[], fallback: Date): Date {
    if (messages.length === 0) {
      return fallback;
    }

    let updatedAt = new Date(messages[0].timestamp);
    for (const message of messages) {
      const ts = new Date(message.timestamp);
      if (ts.getTime() > updatedAt.getTime()) {
        updatedAt = ts;
      }
    }
    return updatedAt;
  }

  private generateSessionId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `ui-${crypto.randomUUID()}`;
    }
    const suffix = Math.random().toString(36).slice(2, 10);
    return `ui-${Date.now()}-${suffix}`;
  }

  private loadState(user: string): RagChatSessionState {
    const empty = RagChatSessionService.emptyState();
    if (typeof sessionStorage === 'undefined') {
      return empty;
    }

    try {
      const raw = sessionStorage.getItem(this.storageKey(user));
      if (!raw) {
        return empty;
      }

      const parsed = JSON.parse(raw) as StoredRagChatSessionState;
      const sessions = Array.isArray(parsed.sessions)
        ? parsed.sessions.map((session) => ({
          sessionId: session.sessionId,
          title: session.title || 'New conversation',
          createdAt: new Date(session.createdAt),
          updatedAt: new Date(session.updatedAt),
          messages: (session.messages ?? []).map((message) => ({
            ...message,
            timestamp: new Date(message.timestamp)
          }))
        }))
        : [];

      sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      const activeSessionId = parsed.activeSessionId ?? sessions[0]?.sessionId ?? null;

      return { activeSessionId, sessions };
    } catch {
      return empty;
    }
  }

  private persist(): void {
    if (typeof sessionStorage === 'undefined' || !this.owner) {
      return;
    }
    const state = this.stateValue;

    const payload: StoredRagChatSessionState = {
      activeSessionId: state.activeSessionId,
      sessions: state.sessions.map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        messages: session.messages.map((message) => ({
          ...message,
          timestamp: message.timestamp.toISOString()
        }))
      }))
    };

    sessionStorage.setItem(this.storageKey(this.owner), JSON.stringify(payload));
  }
}
