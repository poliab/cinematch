import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  AiProviderRequestOptions,
  IAiRecommendationProvider,
} from './ai-provider.interface';
import { NormalizedRecommendationResult } from '../dto/recommendation-response.dto';
import {
  normalizeGoogleTokenUsage,
  parseAiRecommendationJson,
} from './ai-response.parser';

@Injectable()
export class GoogleAiProviderService implements IAiRecommendationProvider {
  private readonly logger = new Logger(GoogleAiProviderService.name);
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly temperature: number;
  private readonly thinkingLevel: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.apiKey = this.config.get<string>('ai.google.apiKey');
    this.model = this.config.get<string>('ai.google.model') ?? 'gemini-1.5-flash';
    this.temperature = this.config.get<number>('ai.temperature') ?? 0.2;
    this.thinkingLevel = this.config.get<string>('ai.google.thinkingLevel') ?? 'MINIMAL';
    this.timeoutMs = this.config.get<number>('ai.google.timeoutMs') ?? 10000;
  }

  async getRecommendations(
    prompt: string,
    options?: AiProviderRequestOptions,
  ): Promise<NormalizedRecommendationResult> {
    if (!this.apiKey || this.apiKey === 'placeholder_key') {
      throw new Error('Google AI API key not configured');
    }

    const model = options?.model ?? this.model;
    const temperature = options?.temperature ?? this.temperature;
    const thinkingLevel = options?.thinkingLevel ?? this.thinkingLevel;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;

    const startTime = Date.now();

    try {
      const response = await firstValueFrom(
        this.http.post(
          url,
          {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature,
              responseMimeType: 'application/json',
              thinkingConfig: { thinkingLevel },
            },
          },
          { timeout: timeoutMs },
        ),
      );

      const latency = Date.now() - startTime;
      this.logger.log(`Google AI (${model}) responded in ${latency}ms`);

      const parts: any[] = response.data?.candidates?.[0]?.content?.parts ?? [];
      // Reasoning-capable models (e.g. Gemma 4 31B) can prepend a thought part before the JSON part.
      const text: string =
        [...parts].reverse().find((p) => !p?.thought && typeof p?.text === 'string')?.text ??
        parts?.[0]?.text ??
        '';

      const parsed = parseAiRecommendationJson(text);
      if (!parsed.jsonValid) {
        this.logger.warn(
          `Failed to parse Google AI JSON response. Raw text (first 200 chars): ${text.slice(0, 200)}`,
        );
      }

      return {
        movieTmdbIds: parsed.movieTmdbIds,
        items: parsed.items,
        explanation: parsed.explanation ?? 'Movies selected based on your preferences.',
        providerUsed: 'google',
        isFallback: false,
        rawText: text,
        jsonValid: parsed.jsonValid,
        tokenUsage: normalizeGoogleTokenUsage(response.data?.usageMetadata),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      this.logger.warn(
        `Google AI (${model}) failed after ${latency}ms: ${err?.message ?? 'unknown error'}`,
      );
      throw err;
    }
  }
}
