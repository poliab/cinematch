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
  normalizeOpenAiTokenUsage,
  parseAiRecommendationJson,
} from './ai-response.parser';

@Injectable()
export class OpenRouterProviderService implements IAiRecommendationProvider {
  private readonly logger = new Logger(OpenRouterProviderService.name);
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.apiKey = this.config.get<string>('ai.openrouter.apiKey');
    this.baseUrl =
      this.config.get<string>('ai.openrouter.baseUrl') ??
      'https://openrouter.ai/api/v1';
    this.model =
      this.config.get<string>('ai.openrouter.model') ??
      'mistralai/mistral-7b-instruct';
    this.temperature = this.config.get<number>('ai.temperature') ?? 0.2;
    this.timeoutMs = this.config.get<number>('ai.openrouter.timeoutMs') ?? 10000;
  }

  async getRecommendations(
    prompt: string,
    options?: AiProviderRequestOptions,
  ): Promise<NormalizedRecommendationResult> {
    if (!this.apiKey || this.apiKey === 'placeholder_key') {
      throw new Error('OpenRouter API key not configured');
    }

    const model = options?.model ?? this.model;
    const temperature = options?.temperature ?? this.temperature;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const url = `${this.baseUrl}/chat/completions`;
    const startTime = Date.now();

    try {
      const systemMessage =
        'You are a helpful movie recommendation assistant. ' +
        'Always respond with a valid JSON object matching the schema requested in the user prompt. ' +
        'No markdown, no extra text.';

      const response = await firstValueFrom(
        this.http.post(
          url,
          {
            model,
            temperature,
            messages: [
              { role: 'system', content: systemMessage },
              { role: 'user', content: prompt },
            ],
          },
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: timeoutMs,
          },
        ),
      );

      const latency = Date.now() - startTime;
      this.logger.log(`OpenRouter (${model}) responded in ${latency}ms`);

      const text: string =
        response.data?.choices?.[0]?.message?.content ?? '';

      const parsed = parseAiRecommendationJson(text);
      if (!parsed.jsonValid) {
        this.logger.warn(
          `Failed to parse OpenRouter JSON response. Raw text (first 200 chars): ${text.slice(0, 200)}`,
        );
      }

      return {
        movieTmdbIds: parsed.movieTmdbIds,
        items: parsed.items,
        explanation: parsed.explanation ?? 'Curated selection based on your request.',
        providerUsed: 'openrouter',
        isFallback: false,
        rawText: text,
        jsonValid: parsed.jsonValid,
        tokenUsage: normalizeOpenAiTokenUsage(response.data?.usage),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      this.logger.warn(
        `OpenRouter (${model}) failed after ${latency}ms: ${err?.message ?? 'unknown error'}`,
      );
      throw err;
    }
  }
}
