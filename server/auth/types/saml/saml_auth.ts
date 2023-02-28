/*
 *   Copyright OpenSearch Contributors
 *
 *   Licensed under the Apache License, Version 2.0 (the "License").
 *   You may not use this file except in compliance with the License.
 *   A copy of the License is located at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   or in the "license" file accompanying this file. This file is distributed
 *   on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 *   express or implied. See the License for the specific language governing
 *   permissions and limitations under the License.
 */

import { escape } from 'querystring';
import { CoreSetup } from 'opensearch-dashboards/server';
import { SecurityPluginConfigType } from '../../..';
import {
  SessionStorageFactory,
  IRouter,
  ILegacyClusterClient,
  OpenSearchDashboardsRequest,
  AuthToolkit,
  Logger,
  LifecycleResponseFactory,
  IOpenSearchDashboardsResponse,
  AuthResult,
} from '../../../../../../src/core/server';
import {
  SecuritySessionCookie,
  clearOldVersionCookieValue,
} from '../../../session/security_cookie';
import { SamlAuthRoutes } from './routes';
import { AuthenticationType } from '../authentication_type';
import { AuthType } from '../../../../common';
import { deflateValue, inflateValue } from '../../../utils/compression';
import { unsplitCookiesIntoValue } from '../../../session/cookie_splitter';
import { Server } from '@hapi/hapi';

export class SamlAuthentication extends AuthenticationType {
  public static readonly AUTH_HEADER_NAME = 'authorization';

  public readonly type: string = 'saml';

  private readonly extraCookieName: string;

  constructor(
    config: SecurityPluginConfigType,
    sessionStorageFactory: SessionStorageFactory<SecuritySessionCookie>,
    router: IRouter,
    esClient: ILegacyClusterClient,
    coreSetup: CoreSetup,
    logger: Logger
  ) {
    super(config, sessionStorageFactory, router, esClient, coreSetup, logger);

    // TODO: Using the session storage like this was probably not intended
    // @ts-ignore
    const hapiServer: Server = this.sessionStorageFactory.asScoped({}).server;
    this.extraCookieName = this.config.cookie.name + '_saml';
    const extraCookieSettings = {
      isSecure: config.cookie.secure,
      isSameSite: config.cookie.isSameSite,
      password: config.cookie.password,
      clearInvalid: false,
      isHttpOnly: true,
      // encoding: 'iron',
      domain: config.cookie.domain,
      path: this.coreSetup.http.basePath.serverBasePath || '/',
    };

    // TODO: The quantity of extra cookies could be configurable
    hapiServer.states.add(this.extraCookieName + '_1', extraCookieSettings);
    hapiServer.states.add(this.extraCookieName + '_2', extraCookieSettings);
  }

  private generateNextUrl(request: OpenSearchDashboardsRequest): string {
    const path =
      this.coreSetup.http.basePath.serverBasePath +
      (request.url.pathname || '/app/opensearch-dashboards');
    return escape(path);
  }

  // Check if we can get the previous tenant information from the expired cookie.
  private redirectSAMlCapture = (request: OpenSearchDashboardsRequest, toolkit: AuthToolkit) => {
    const nextUrl = this.generateNextUrl(request);
    const clearOldVersionCookie = clearOldVersionCookieValue(this.config);
    return toolkit.redirected({
      location: `${this.coreSetup.http.basePath.serverBasePath}/auth/saml/captureUrlFragment?nextUrl=${nextUrl}`,
      'set-cookie': clearOldVersionCookie,
    });
  };

  public async init() {
    const samlAuthRoutes = new SamlAuthRoutes(
      this.router,
      this.config,
      this.sessionStorageFactory,
      this.securityClient,
      this.coreSetup
    );
    samlAuthRoutes.setupRoutes(this.extraCookieName);
  }

  requestIncludesAuthInfo(request: OpenSearchDashboardsRequest): boolean {
    return request.headers[SamlAuthentication.AUTH_HEADER_NAME] ? true : false;
  }

  async getAdditionalAuthHeader(request: OpenSearchDashboardsRequest): Promise<any> {
    return {};
  }

  getCookie(request: OpenSearchDashboardsRequest, authInfo: any): SecuritySessionCookie {
    return {
      username: authInfo.user_name,
      credentials: {
        authHeaderValueCompressed: deflateValue(
          request.headers[SamlAuthentication.AUTH_HEADER_NAME] as string
        ),
      },
      authType: AuthType.SAML,
      expiryTime: Date.now() + this.config.session.ttl,
    };
  }

  // Can be improved to check if the token is expiring.
  async isValidCookie(cookie: SecuritySessionCookie): Promise<boolean> {
    return (
      cookie.authType === AuthType.SAML &&
      cookie.username &&
      cookie.expiryTime &&
      (cookie.credentials?.authHeaderValue || cookie.credentials?.authHeaderValueCompressed)
    );
  }

  handleUnauthedRequest(
    request: OpenSearchDashboardsRequest,
    response: LifecycleResponseFactory,
    toolkit: AuthToolkit
  ): IOpenSearchDashboardsResponse | AuthResult {
    if (this.isPageRequest(request)) {
      return this.redirectSAMlCapture(request, toolkit);
    } else {
      return response.unauthorized();
    }
  }

  buildAuthHeaderFromCookie(
    cookie: SecuritySessionCookie,
    request: OpenSearchDashboardsRequest
  ): any {
    const headers: any = {};

    if (cookie.credentials?.authHeaderValueCompressed) {
      try {
        const fullCookieValue = unsplitCookiesIntoValue(request, this.extraCookieName);
        const inflatedFullCookieValue = inflateValue(Buffer.from(fullCookieValue, 'base64'));
        headers[SamlAuthentication.AUTH_HEADER_NAME] = inflatedFullCookieValue.toString();
      } catch (error) {
        this.logger.error(error);
        // @todo Re-throw?
        // throw error;
      }
    } else {
      headers[SamlAuthentication.AUTH_HEADER_NAME] = cookie.credentials?.authHeaderValue;
    }

    return headers;
  }
}
