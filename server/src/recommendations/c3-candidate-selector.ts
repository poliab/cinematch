import { extractReleaseYear, normalizeMovieTitle } from './movie-title-matcher';

export interface C3CatalogMovie {
  id: number;
  tmdbId: number;
  title: string;
  titleEn?: string | null;
  overview?: string | null;
  releaseDate?: Date | string | null;
  voteAverage?: number;
  voteCount?: number;
  popularity?: number;
  genreNames: string[];
}

export interface ExtractedQueryConstraints {
  requiredGenres: string[];
  excludedGenres: string[];
  softGenres: string[];
  minYear?: number;
  maxYear?: number;
  seedMovie?: C3CatalogMovie;
}

export interface CandidateSelectionResult {
  constraints: ExtractedQueryConstraints;
  candidates: C3CatalogMovie[];
  strictMatchCount: number;
}

const GENRE_PATTERNS: { genre: string; regex: RegExp }[] = [
  { genre: 'Мелодрама', regex: /(?:^|[^\p{L}])(мелодрам|романтик|романтич|коханн|любов|побачен|romance)/iu },
  { genre: 'Драма', regex: /(?:^|[^\p{L}])(драм|drama)/iu },
  { genre: 'Комедія', regex: /(?:^|[^\p{L}])(комед|посміят|смішн|гумор|comedy)/iu },
  { genre: 'Бойовик', regex: /(?:^|[^\p{L}])(бойовик|екшн|екшен|action)/iu },
  { genre: 'Пригоди', regex: /(?:^|[^\p{L}])(пригод|adventure)/iu },
  { genre: 'Трилер', regex: /(?:^|[^\p{L}])(трилер|thriller)/iu },
  { genre: 'Фантастика', regex: /(?:^|[^\p{L}])(фантаст|сай-фай|sci-?fi|науков[а-яіїє']*\s+фантаст)/iu },
  { genre: 'Мультфільм', regex: /(?:^|[^\p{L}])(мульт|анімац|animation|animated)/iu },
  { genre: 'Кримінал', regex: /(?:^|[^\p{L}])(кримін|гангстер|мафі|crime)/iu },
  { genre: 'Документальний', regex: /(?:^|[^\p{L}])(документал|documentary)/iu },
  { genre: 'Сімейний', regex: /(?:^|[^\p{L}])(сімейн|для\s+дітей|з\s+дітьми|family)/iu },
  { genre: 'Фентезі', regex: /(?:^|[^\p{L}])(фентез|магі|чар|fantasy)/iu },
  { genre: 'Історичний', regex: /(?:^|[^\p{L}])(історич|історі|history|historical)/iu },
  { genre: 'Жахи', regex: /(?:^|[^\p{L}])(жах|хорор|горрор|страшн|скрімер|horror)/iu },
  { genre: 'Музика', regex: /(?:^|[^\p{L}])(музич|про\s+музик|мюзикл|music)/iu },
  { genre: 'Детектив', regex: /(?:^|[^\p{L}])(детектив|розслідуван|mystery)/iu },
  { genre: 'Телефільм', regex: /(?:^|[^\p{L}])(телефільм|tv\s+movie)/iu },
  { genre: 'Військовий', regex: /(?:^|[^\p{L}])(військов|воєнн|війн|war)/iu },
  { genre: 'Вестерн', regex: /(?:^|[^\p{L}])(вестерн|дикий\s+захід|western)/iu },
];

const SCENARIO_GENRE_HINTS: Record<string, { soft: string[]; excluded: string[] }> = {
  something_light: { soft: ['Комедія', 'Мультфільм', 'Сімейний', 'Пригоди'], excluded: ['Жахи'] },
  something_intense: { soft: ['Трилер', 'Бойовик', 'Кримінал'], excluded: [] },
  watch_with_friends: { soft: ['Комедія', 'Бойовик', 'Пригоди'], excluded: [] },
  new_scifi: { soft: ['Фантастика'], excluded: [] },
  no_horror: { soft: [], excluded: ['Жахи'] },
  not_sure: { soft: [], excluded: [] },
  warm_romance: { soft: ['Мелодрама', 'Драма'], excluded: [] },
  tense_thriller: { soft: ['Трилер', 'Детектив'], excluded: ['Жахи'] },
};

const SOFT_MOOD_PATTERNS: { genres: string[]; regex: RegExp }[] = [
  { genres: ['Комедія', 'Пригоди', 'Сімейний'], regex: /(легк|розслаб|піцу|друз|весел)/iu },
  { genres: ['Бойовик', 'Трилер', 'Кримінал'], regex: /(драйв|адреналін|напруз)/iu },
  { genres: ['Мелодрама', 'Драма'], regex: /(затишн|душевн|побачен|тепл|сумн|меланхол|ностальг)/iu },
  { genres: ['Фантастика'], regex: /(космос|майбутн|шІ|робот|кіберпанк)/iu },
  { genres: ['Драма', 'Біографія', 'Історичний'], regex: /(мотиву|надиха|реальн)/iu },
];

const SEED_CUE_RE =
  /(?:схож\p{L}*\s+на(?:\s+фільм)?|подібн\p{L}*\s+до|на\s+кшталт(?:\s+стрічки)?|в\s+дусі|типу|як(?:\s+фільм)?|сподобав\p{L}*(?:\s+фільм)?|similar\s+to|like)\s+([^,.;!?]+)/iu;

function extractYearConstraints(text: string): { minYear?: number; maxYear?: number } {
  let minYear: number | undefined;
  let maxYear: number | undefined;

  const rangeMatch = text.match(
    /(?:між|з|від|between|from)\s+(\d{4})\s*(?:і|та|й|по|до|and|to|-|–)\s*(\d{4})/iu,
  );
  if (rangeMatch) {
    const y1 = Number.parseInt(rangeMatch[1], 10);
    const y2 = Number.parseInt(rangeMatch[2], 10);
    minYear = Math.min(y1, y2);
    maxYear = Math.max(y1, y2);
    return { minYear, maxYear };
  }

  const decadeMatch = text.match(/(?:^|[^\d])(\d{2})-?х(?:\s+рок)?/iu);
  if (decadeMatch) {
    const d = Number.parseInt(decadeMatch[1], 10);
    const base = d >= 20 ? 1900 + d : 2000 + d;
    minYear = base;
    maxYear = base + 9;
  }

  const afterMatch = text.match(/після\s+(\d{4})/iu);
  if (afterMatch) {
    const y = Number.parseInt(afterMatch[1], 10) + 1;
    minYear = minYear !== undefined ? Math.max(minYear, y) : y;
  }

  const sinceMatch = text.match(
    /(?:не\s+старіше|не\s+раніше|від|з|since|after)\s+(\d{4})/iu,
  );
  if (sinceMatch) {
    const y = Number.parseInt(sinceMatch[1], 10);
    minYear = minYear !== undefined ? Math.max(minYear, y) : y;
  }

  const beforeMatch = text.match(/(?:до|не\s+пізніше|before|until)\s+(\d{4})/iu);
  if (beforeMatch) {
    const y = Number.parseInt(beforeMatch[1], 10);
    maxYear = maxYear !== undefined ? Math.min(maxYear, y) : y;
  }

  return { minYear, maxYear };
}

function findGenresInClause(clause: string): string[] {
  const found: string[] = [];
  for (const { genre, regex } of GENRE_PATTERNS) {
    if (regex.test(clause) && !found.includes(genre)) {
      found.push(genre);
    }
  }
  return found;
}

function stemToken(token: string): string {
  if (token.length >= 6 && /(?:ого|ому)$/iu.test(token)) {
    return token.slice(0, -3);
  }
  if (token.length >= 4 && /[аяоеуіиюїє]$/iu.test(token)) {
    return token.slice(0, -1);
  }
  return token;
}

function findSeedMovieInText(text: string, catalog: C3CatalogMovie[]): C3CatalogMovie | undefined {
  const cueMatch = text.match(SEED_CUE_RE);
  if (!cueMatch) return undefined;

  const rawTail = cueMatch[1]
    .replace(/[«»"'.,!?]/g, ' ')
    .replace(/(?:^|[^\p{L}\p{N}])\d{4}(?:\s+(?:року|р\.?))?(?=$|[^\p{L}\p{N}])/giu, ' ')
    .trim();
  const segments = rawTail
    .split(/\s+(?:або|чи|зі|із|з|,|але)\s+/iu)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);

  for (const seg of segments) {
    const normQuery = normalizeMovieTitle(seg);
    if (!normQuery || normQuery.length < 3) continue;
    const allTokens = normQuery.split(' ').filter((t) => t.length >= 3);
    if (!allTokens.length) continue;

    // Try full segment first, then progressively drop a trailing modifier (e.g. director name "Нолана").
    const tokenSlices: string[][] = [allTokens];
    if (allTokens.length >= 2) {
      tokenSlices.push(allTokens.slice(0, -1));
    }

    for (const tokens of tokenSlices) {
      const tokenPrefixes = tokens.map(stemToken);

      let best: C3CatalogMovie | undefined;
      let bestPop = -1;
      for (const movie of catalog) {
        const titles = [movie.title, movie.titleEn].filter(Boolean) as string[];
        for (const candidateTitle of titles) {
          const normCand = normalizeMovieTitle(candidateTitle);
          if (!normCand) continue;
          const candStems = normCand.split(' ').map(stemToken);
          const exactHit = normCand === tokens.join(' ');
          const prefixHit =
            tokenPrefixes.every((pref) =>
              candStems.some((cs) => cs === pref || cs.startsWith(pref) || (pref.length >= 4 && pref.startsWith(cs))),
            ) && candStems.length <= tokens.length + 3;

          if (exactHit || prefixHit) {
            const score = (exactHit ? 1000 : 0) + (movie.popularity ?? 0);
            if (score > bestPop) {
              bestPop = score;
              best = movie;
            }
          }
        }
      }
      if (best) return best;
    }
  }

  return undefined;
}

export function extractQueryConstraints(
  signals: {
    freeTextPrompt?: string;
    moodInput?: string;
    scenarioKey?: string;
    genreName?: string;
    seedMovieTitle?: string;
    favoriteGenreNames?: string[];
    refinements?: Record<string, boolean>;
  },
  catalog: C3CatalogMovie[],
): ExtractedQueryConstraints {
  const requiredGenres: string[] = [];
  const excludedGenres: string[] = [];
  const softGenres: string[] = [];

  if (signals.genreName) {
    requiredGenres.push(signals.genreName);
  }

  if (signals.scenarioKey && SCENARIO_GENRE_HINTS[signals.scenarioKey]) {
    const hint = SCENARIO_GENRE_HINTS[signals.scenarioKey];
    for (const g of hint.excluded) {
      if (!excludedGenres.includes(g)) excludedGenres.push(g);
    }
    for (const g of hint.soft) {
      if (!softGenres.includes(g)) softGenres.push(g);
    }
    if (signals.scenarioKey === 'new_scifi' && !requiredGenres.includes('Фантастика')) {
      requiredGenres.push('Фантастика');
    }
    if (signals.scenarioKey === 'warm_romance' && !requiredGenres.includes('Мелодрама')) {
      requiredGenres.push('Мелодрама');
    }
    if (signals.scenarioKey === 'tense_thriller' && !requiredGenres.includes('Трилер')) {
      requiredGenres.push('Трилер');
    }
  }

  if (signals.refinements?.lessRomantic && !excludedGenres.includes('Мелодрама')) {
    excludedGenres.push('Мелодрама');
  }

  const combinedText = [signals.freeTextPrompt, signals.moodInput].filter(Boolean).join(' ');
  const { minYear, maxYear } = extractYearConstraints(combinedText);

  let effectiveMinYear = minYear;
  if (signals.refinements?.newer && effectiveMinYear === undefined) {
    effectiveMinYear = 2018;
  }

  // Split by clause boundaries, keeping negation markers inside each clause.
  const clauses = combinedText
    .split(/[,.;]+|\s+але\s+|\s+тільки\s+|\s+головне\s+/iu)
    .map((c) => c.trim())
    .filter(Boolean);

  for (const clause of clauses) {
    // Handle patterns like "без X і без Y" or "не сімейний" or "строго без X і Y"
    const negMatch = clause.match(/(?:^|\s)(без|не|окрім|крім|виключаючи|without|no)\s+(.+)$/iu);
    if (negMatch) {
      const beforeNeg = clause.slice(0, negMatch.index ?? 0).trim();
      const negTail = negMatch[2];

      for (const g of findGenresInClause(beforeNeg)) {
        if (!requiredGenres.includes(g)) requiredGenres.push(g);
      }
      for (const g of findGenresInClause(negTail)) {
        // Paradoxical phrase like "жахів, але не страшний" shouldn't exclude Жахи itself unless explicitly "без жахів"
        if (!excludedGenres.includes(g) && !(requiredGenres.includes(g) && /страшн/iu.test(negTail))) {
          excludedGenres.push(g);
        }
      }
    } else {
      for (const g of findGenresInClause(clause)) {
        if (!requiredGenres.includes(g)) requiredGenres.push(g);
      }
    }
  }

  // Remove accidental contradictions from excluded if explicitly required unless genuinely conflicting
  const cleanExcluded = excludedGenres.filter((g) => !requiredGenres.includes(g));

  // Soft mood hints only when explicit genres weren't specified
  if (requiredGenres.length === 0) {
    for (const { genres, regex } of SOFT_MOOD_PATTERNS) {
      if (regex.test(combinedText)) {
        for (const g of genres) {
          if (!cleanExcluded.includes(g) && !softGenres.includes(g)) {
            softGenres.push(g);
          }
        }
      }
    }
  }

  let seedMovie: C3CatalogMovie | undefined;
  if (signals.seedMovieTitle) {
    const normSeed = normalizeMovieTitle(signals.seedMovieTitle);
    seedMovie = catalog.find(
      (m) =>
        normalizeMovieTitle(m.title) === normSeed ||
        (m.titleEn && normalizeMovieTitle(m.titleEn) === normSeed),
    );
  }
  if (!seedMovie && signals.freeTextPrompt) {
    seedMovie = findSeedMovieInText(signals.freeTextPrompt, catalog);
  }

  if (seedMovie) {
    for (const g of seedMovie.genreNames) {
      if (!cleanExcluded.includes(g) && !softGenres.includes(g)) {
        softGenres.push(g);
      }
    }
  }

  if (signals.favoriteGenreNames?.length && requiredGenres.length === 0 && softGenres.length === 0) {
    for (const g of signals.favoriteGenreNames) {
      if (!cleanExcluded.includes(g) && !softGenres.includes(g)) {
        softGenres.push(g);
      }
    }
  }

  return {
    requiredGenres,
    excludedGenres: cleanExcluded,
    softGenres,
    minYear: effectiveMinYear,
    maxYear,
    seedMovie,
  };
}

function scoreCandidate(
  movie: C3CatalogMovie,
  constraints: ExtractedQueryConstraints,
): number {
  const movieGenreSet = new Set(movie.genreNames);
  let score = 0;

  for (const g of constraints.requiredGenres) {
    if (movieGenreSet.has(g)) score += 30;
  }
  for (const g of constraints.softGenres) {
    if (movieGenreSet.has(g)) score += 12;
  }
  if (constraints.seedMovie) {
    const overlap = constraints.seedMovie.genreNames.filter((g) => movieGenreSet.has(g)).length;
    score += overlap * 10;
  }

  const rating = movie.voteAverage ?? 0;
  const votes = movie.voteCount ?? 0;
  const pop = movie.popularity ?? 0;

  score += rating * 1.5 + Math.log10(votes + 1) * 2 + Math.log10(pop + 1) * 1.5;
  return score;
}

export function selectCandidatesForC3(
  signals: {
    freeTextPrompt?: string;
    moodInput?: string;
    scenarioKey?: string;
    genreName?: string;
    seedMovieTitle?: string;
    favoriteGenreNames?: string[];
    refinements?: Record<string, boolean>;
  },
  catalog: C3CatalogMovie[],
  excludeMovieIds: number[] = [],
  targetLimit = 40,
  minPoolSize = 30,
): CandidateSelectionResult {
  const constraints = extractQueryConstraints(signals, catalog);
  const excludedIds = new Set(excludeMovieIds);
  if (constraints.seedMovie) {
    excludedIds.add(constraints.seedMovie.id);
  }

  const eligible = catalog.filter((m) => !excludedIds.has(m.id));

  const strictMatches: C3CatalogMovie[] = [];
  const relaxedMatches: C3CatalogMovie[] = [];

  for (const movie of eligible) {
    const genreSet = new Set(movie.genreNames);
    if (constraints.excludedGenres.some((g) => genreSet.has(g))) {
      continue;
    }

    const year = extractReleaseYear(movie.releaseDate);
    const matchesRequired = constraints.requiredGenres.every((g) => genreSet.has(g));
    const matchesMinYear =
      constraints.minYear === undefined || (year !== null && year >= constraints.minYear);
    const matchesMaxYear =
      constraints.maxYear === undefined || (year !== null && year <= constraints.maxYear);

    if (matchesRequired && matchesMinYear && matchesMaxYear) {
      strictMatches.push(movie);
    } else {
      relaxedMatches.push(movie);
    }
  }

  strictMatches.sort((a, b) => scoreCandidate(b, constraints) - scoreCandidate(a, constraints));

  if (strictMatches.length >= minPoolSize) {
    return {
      constraints,
      candidates: strictMatches.slice(0, targetLimit),
      strictMatchCount: strictMatches.length,
    };
  }

  // Narrow query fallback: keep all strict matches first, pad up to minPoolSize using best relaxed matches
  // that still obey excludedGenres (so LLM receives enough candidates while prioritizing exact matches).
  relaxedMatches.sort((a, b) => scoreCandidate(b, constraints) - scoreCandidate(a, constraints));
  const padded = [...strictMatches, ...relaxedMatches].slice(0, minPoolSize);

  return {
    constraints,
    candidates: padded,
    strictMatchCount: strictMatches.length,
  };
}

export function formatCandidatesForPrompt(candidates: C3CatalogMovie[]): string {
  return candidates
    .map((m) => {
      const year = extractReleaseYear(m.releaseDate);
      const yearLabel = year !== null ? String(year) : 'n/a';
      const displayTitle =
        m.titleEn && m.titleEn.trim() && m.titleEn.trim().toLowerCase() !== m.title.trim().toLowerCase()
          ? `${m.title} / ${m.titleEn}`
          : m.title;
      const genres = m.genreNames.length > 0 ? m.genreNames.join(', ') : '—';
      return `${m.tmdbId} | ${displayTitle} (${yearLabel}) [${genres}]`;
    })
    .join('\n');
}
