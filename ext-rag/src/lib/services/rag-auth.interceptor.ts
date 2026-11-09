import { Injectable } from '@angular/core';
import {
  HttpInterceptor,
  HttpRequest,
  HttpHandler,
  HttpEvent
} from '@angular/common/http';
import { Observable } from 'rxjs';
import { AppConfigService } from '@alfresco/adf-core';
import { findEcmTicket } from '../utils/ecm-ticket.util';

/**
 * HTTP interceptor that attaches the Alfresco authentication
 * credentials to every request matching the RAG base path.
 *
 * Reads the ECM ticket directly from the storage layer where ADF
 * persists it, avoiding reliance on AuthenticationService methods
 * that may filter by URL or return stale tokens.
 *
 * Registered automatically via `provideRagExtension()`.
 */
@Injectable()
export class RagAuthInterceptor implements HttpInterceptor {

  private readonly ragMatchers: string[];
  private readonly contentLakeMatchers: string[];
  private readonly statusMatchers: string[];

  constructor(private appConfig: AppConfigService) {
    const configuredRagBaseUrl = this.appConfig.get<string>('plugins.ragService.baseUrl', '/api/rag');
    const configuredContentLakeBaseUrl = this.appConfig.get<string>('plugins.contentLakeService.baseUrl', '/api/content-lake');
    const configuredStatusUrl = this.appConfig.get<string>('plugins.ragService.statusUrl', '/api/status');

    this.ragMatchers = this.buildMatchers('/api/rag', configuredRagBaseUrl);
    this.contentLakeMatchers = this.buildMatchers('/api/content-lake', configuredContentLakeBaseUrl);
    // /api/status is served by rag-service but lives outside /api/rag, so it needs
    // its own matcher; without the ticket it 401s and the browser shows a Basic-auth prompt.
    this.statusMatchers = this.buildMatchers('/api/status', configuredStatusUrl);
  }

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    const url = req.url;

    const isRagCall = this.matchesAny(url, this.ragMatchers);
    const isContentLakeCall = this.matchesAny(url, this.contentLakeMatchers);
    const isStatusCall = this.matchesAny(url, this.statusMatchers);
    if (!isRagCall && !isContentLakeCall && !isStatusCall) return next.handle(req);

    const ticket = findEcmTicket();

    if (!ticket) return next.handle(req);

    // Every App for OpenArch service reads the ticket the same way: as the username of a Basic header,
    // with an empty password. Sending the bare ticket to some of them and `ticket:` to others is how
    // the two encodings drifted apart in the first place, so there is deliberately no branch here.
    const encodedCredentials = btoa(ticket + ':');

    return next.handle(req.clone({
      setHeaders: { Authorization: `Basic ${encodedCredentials}` }
    }));
  }

  private buildMatchers(defaultBaseUrl: string, configuredBaseUrl: string): string[] {
    const matchers = new Set<string>([defaultBaseUrl]);

    try {
      const url = new URL(configuredBaseUrl, window.location.origin);
      if (url.pathname && url.pathname !== '/') {
        matchers.add(url.pathname.replace(/\/+$/, ''));
      }
      matchers.add(configuredBaseUrl.replace(/\/+$/, ''));
    } catch {
      matchers.add(configuredBaseUrl.replace(/\/+$/, ''));
    }

    return [...matchers];
  }

  private matchesAny(url: string, matchers: string[]): boolean {
    return matchers.some((matcher) => url.includes(matcher) || url.includes('/' + matcher));
  }
}
