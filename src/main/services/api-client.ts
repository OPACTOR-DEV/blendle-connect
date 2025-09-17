import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { app } from 'electron';
import { logger } from '../utils/logger';

export interface ApiResponse<T = any> {
  success: boolean;
  message: string;
  data?: T;
}

export interface StoreTokenRequest {
  provider: 'claude' | 'codex' | 'gemini';
  userId: string;
  tokenData: string; // JSON string
  originalPath?: string;
  format?: string;
  metadata?: any;
  expiresAt?: string;
}

export class ApiClient {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor() {
    // Determine API base URL based on environment
    this.baseUrl = this.getApiBaseUrl();

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `freerider-connect/${app.getVersion()}`,
      },
    });

    this.setupInterceptors();
  }

  private getApiBaseUrl(): string {
    // Check if running in development mode
    const isDevelopment = process.env.NODE_ENV === 'development' || !app.isPackaged;

    if (isDevelopment) {
      return 'http://localhost:8080';
    } else {
      return 'https://api.freerider.ai';
    }
  }

  private setupInterceptors(): void {
    // Request interceptor
    this.client.interceptors.request.use(
      (config) => {
        logger.debug('ApiClient', `Making request to: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        logger.error('ApiClient', 'Request interceptor error:', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor
    this.client.interceptors.response.use(
      (response) => {
        logger.debug('ApiClient', `Response from ${response.config.url}: ${response.status}`);
        return response;
      },
      (error) => {
        logger.error('ApiClient', `API Error: ${error.message}`);
        if (error.response) {
          logger.error('ApiClient', `Response data:`, error.response.data);
          logger.error('ApiClient', `Response status:`, error.response.status);
        }
        return Promise.reject(error);
      }
    );
  }

  async storeToken(request: StoreTokenRequest): Promise<ApiResponse> {
    try {
      logger.info('ApiClient', `Storing token for provider: ${request.provider}, user: ${request.userId}`);

      const response: AxiosResponse<ApiResponse> = await this.client.post(
        '/api/ai-providers/tokens',
        request
      );

      logger.info('ApiClient', `Token stored successfully for ${request.provider}`);
      return response.data;
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
      logger.error('ApiClient', `Failed to store token for ${request.provider}:`, errorMsg);

      return {
        success: false,
        message: `Failed to store token: ${errorMsg}`,
      };
    }
  }

  async getTokensByUser(userId: string): Promise<ApiResponse> {
    try {
      logger.info('ApiClient', `Retrieving tokens for user: ${userId}`);

      const response: AxiosResponse<ApiResponse> = await this.client.get(
        `/api/ai-providers/tokens?userId=${userId}`
      );

      logger.info('ApiClient', `Tokens retrieved successfully for user: ${userId}`);
      return response.data;
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
      logger.error('ApiClient', `Failed to get tokens for user ${userId}:`, errorMsg);

      return {
        success: false,
        message: `Failed to retrieve tokens: ${errorMsg}`,
      };
    }
  }

  async getTokenByProvider(userId: string, provider: string): Promise<ApiResponse> {
    try {
      logger.info('ApiClient', `Retrieving token for user: ${userId}, provider: ${provider}`);

      const response: AxiosResponse<ApiResponse> = await this.client.get(
        `/api/ai-providers/tokens/${provider}?userId=${userId}`
      );

      logger.info('ApiClient', `Token retrieved successfully for ${provider}`);
      return response.data;
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
      logger.error('ApiClient', `Failed to get token for ${provider}:`, errorMsg);

      return {
        success: false,
        message: `Failed to retrieve token: ${errorMsg}`,
      };
    }
  }

  async markTokenAsUsed(userId: string, provider: string): Promise<ApiResponse> {
    try {
      const response: AxiosResponse<ApiResponse> = await this.client.post(
        `/api/ai-providers/tokens/${provider}/mark-used`,
        { userId }
      );

      return response.data;
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
      logger.error('ApiClient', `Failed to mark token as used for ${provider}:`, errorMsg);

      return {
        success: false,
        message: `Failed to mark token as used: ${errorMsg}`,
      };
    }
  }

  async revokeToken(userId: string, provider: string): Promise<ApiResponse> {
    try {
      const response: AxiosResponse<ApiResponse> = await this.client.delete(
        `/api/ai-providers/tokens/${provider}?userId=${userId}`
      );

      return response.data;
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
      logger.error('ApiClient', `Failed to revoke token for ${provider}:`, errorMsg);

      return {
        success: false,
        message: `Failed to revoke token: ${errorMsg}`,
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      logger.debug('ApiClient', 'Performing health check...');

      // Try a simple GET request to check if the API is accessible
      const response = await this.client.get('/health', { timeout: 5000 });

      logger.info('ApiClient', `Health check successful: ${response.status}`);
      return response.status === 200;
    } catch (error: any) {
      logger.warn('ApiClient', `Health check failed: ${error.message}`);
      return false;
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }
}