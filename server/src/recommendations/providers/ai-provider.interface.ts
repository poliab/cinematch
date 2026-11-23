import {
  NormalizedRecommendationResult,
  RecommendationStrategy,
} from '../dto/recommendation-response.dto';

export interface AiProviderRequestOptions {
  model?: string;
  temperature?: number;
  thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
  timeoutMs?: number;
}

export interface IAiRecommendationProvider {
  getRecommendations(
    prompt: string,
    options?: AiProviderRequestOptions,
  ): Promise<NormalizedRecommendationResult>;
}

export class RecommendationPromptBuilder {
  buildPrompt(
    signals: {
      entryType: string;
      scenarioKey?: string;
      moodInput?: string;
      freeTextPrompt?: string;
      genreName?: string;
      seedMovieTitle?: string;
      favoriteGenreNames?: string[];
      watchedCount?: number;
      refinements?: Record<string, boolean>;
      c3CandidatesBlock?: string;
    },
    strategy: RecommendationStrategy = 'c1',
  ): string {
    const parts: string[] = [];

    if (strategy === 'c2') {
      parts.push(
        'You are a movie recommendation assistant. ' +
          'Return a JSON object with fields: ' +
          '"items" (array of 5-8 objects, each with "title" — the original English movie title as a string, ' +
          'and "year" — the release year as an integer, e.g. {"title": "Interstellar", "year": 2014}), ' +
          '"explanation" (one or two sentences explaining why these movies match the request). ' +
          'Do not return numeric IDs and do not include any text outside the JSON object.',
      );
    } else if (strategy === 'c3') {
      parts.push(
        'You are a movie recommendation assistant. ' +
          'Choose 5-8 movies ONLY from the catalog candidate list below. ' +
          'Strictly obey any genre, exclusion, or release year constraints in the user request. ' +
          'Return a JSON object with fields: ' +
          '"items" (array of 5-8 objects using exact "tmdbId" integers from the candidate list and their "title", ' +
          'e.g. {"tmdbId": 157336, "title": "Interstellar"}), ' +
          '"explanation" (one or two sentences explaining why these movies match the request). ' +
          'Never invent IDs outside the candidate list and do not include any text outside the JSON object.',
      );
    } else {
      parts.push(
        'You are a movie recommendation assistant. ' +
          'Return a JSON object with fields: ' +
          '"items" (array of 5-8 objects, each with "tmdbId" — real TMDb movie ID as integer, ' +
          'and "title" — the movie title you intended for that ID, e.g. {"tmdbId": 157336, "title": "Interstellar"}), ' +
          '"explanation" (one or two sentences explaining why these movies match the request). ' +
          'Do not include any text outside the JSON object.',
      );
    }

    if (signals.freeTextPrompt) {
      parts.push(`User request: "${signals.freeTextPrompt}"`);
    } else if (signals.scenarioKey) {
      const scenarioMap: Record<string, string> = {
        something_light: 'User wants something light and fun to watch.',
        something_intense: 'User wants something intense and gripping.',
        watch_with_friends: 'User wants a movie to watch with friends — entertaining and social.',
        new_scifi: 'User wants a recent sci-fi movie.',
        no_horror: 'User wants recommendations that exclude horror entirely.',
        not_sure: 'User is not sure what they want — suggest popular, broadly appealing movies.',
        warm_romance: 'User wants a warm romantic movie.',
        tense_thriller: 'User wants a tense thriller without horror elements.',
      };
      parts.push(scenarioMap[signals.scenarioKey] ?? `User scenario: ${signals.scenarioKey}`);
    }

    if (signals.moodInput) {
      parts.push(`User mood: ${signals.moodInput}.`);
    }

    if (signals.genreName) {
      parts.push(`Preferred genre: ${signals.genreName}.`);
    }

    if (signals.seedMovieTitle) {
      parts.push(`Find movies similar to: "${signals.seedMovieTitle}".`);
    }

    if (signals.favoriteGenreNames?.length) {
      parts.push(`User typically enjoys: ${signals.favoriteGenreNames.join(', ')}.`);
    }

    if (signals.refinements?.lighter) parts.push('User wants something lighter in tone.');
    if (signals.refinements?.darker) parts.push('User wants something darker in tone.');
    if (signals.refinements?.newer) parts.push('Prefer newer/recent releases.');
    if (signals.refinements?.moreSerious) parts.push('User wants something more serious.');
    if (signals.refinements?.lessRomantic) parts.push('Avoid strong romantic elements.');

    if (signals.c3CandidatesBlock) {
      parts.push('');
      parts.push('Catalog candidates (tmdbId | title (year) [genres]):');
      parts.push(signals.c3CandidatesBlock);
    }

    return parts.join('\n');
  }
}
