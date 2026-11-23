import {
  CatalogMovieCandidate,
  extractMainTitle,
  findBestCatalogMatch,
  normalizeMovieTitle,
} from './movie-title-matcher';

describe('MovieTitleMatcher', () => {
  const catalog: CatalogMovieCandidate[] = [
    {
      id: 1,
      tmdbId: 157336,
      title: 'Інтерстеллар',
      titleEn: 'Interstellar',
      releaseDate: new Date('2014-11-05T00:00:00Z'),
      popularity: 56.5,
      voteCount: 35000,
    },
    {
      id: 2,
      tmdbId: 603,
      title: 'Матриця',
      titleEn: 'The Matrix',
      releaseDate: new Date('1999-03-31T00:00:00Z'),
      popularity: 36.5,
      voteCount: 25000,
    },
    {
      id: 3,
      tmdbId: 841,
      title: 'Дюна',
      titleEn: 'Dune',
      releaseDate: new Date('1984-12-14T00:00:00Z'),
      popularity: 12.0,
      voteCount: 2900,
    },
    {
      id: 4,
      tmdbId: 438631,
      title: 'Дюна',
      titleEn: 'Dune',
      releaseDate: new Date('2021-09-15T00:00:00Z'),
      popularity: 39.1,
      voteCount: 12000,
    },
    {
      id: 5,
      tmdbId: 496243,
      title: 'Паразити',
      titleEn: 'Parasite',
      releaseDate: new Date('2019-05-30T00:00:00Z'),
      popularity: 29.9,
      voteCount: 18000,
    },
    {
      id: 6,
      tmdbId: 76341,
      title: 'Шалений Макс: Дорога гніву',
      titleEn: 'Mad Max: Fury Road',
      releaseDate: new Date('2015-05-13T00:00:00Z'),
      popularity: 31.0,
      voteCount: 22000,
    },
    {
      id: 7,
      tmdbId: 238,
      title: 'Хрещений батько',
      titleEn: 'The Godfather',
      releaseDate: new Date('1972-03-14T00:00:00Z'),
      popularity: 40.4,
      voteCount: 20000,
    },
  ];

  it('matches exact title and release year', () => {
    const match = findBestCatalogMatch('Interstellar', 2014, catalog);
    expect(match).not.toBeNull();
    expect(match!.candidate.tmdbId).toBe(157336);
    expect(match!.tier).toBe('exact');
    expect(match!.yearDiff).toBe(0);
  });

  it('matches titles regardless of letter case and punctuation', () => {
    const match = findBestCatalogMatch('  INTERSTELLAR  ', 2014, catalog);
    expect(match).not.toBeNull();
    expect(match!.candidate.tmdbId).toBe(157336);
    expect(match!.tier).toBe('exact');
  });

  it('matches when leading English article differs ("Matrix" vs "The Matrix")', () => {
    const match = findBestCatalogMatch('Matrix', 1999, catalog);
    expect(match).not.toBeNull();
    expect(match!.candidate.tmdbId).toBe(603);
    expect(match!.tier).toBe('article_stripped');

    const withArticle = findBestCatalogMatch('Godfather', 1972, catalog);
    expect(withArticle).not.toBeNull();
    expect(withArticle!.candidate.tmdbId).toBe(238);
    expect(withArticle!.tier).toBe('article_stripped');
  });

  it('matches when title includes or omits a subtitle', () => {
    const withoutSubtitle = findBestCatalogMatch('Mad Max', 2015, catalog);
    expect(withoutSubtitle).not.toBeNull();
    expect(withoutSubtitle!.candidate.tmdbId).toBe(76341);
    expect(withoutSubtitle!.tier).toBe('subtitle');

    const withSubtitle = findBestCatalogMatch('Dune: Part One', 2021, catalog);
    expect(withSubtitle).not.toBeNull();
    expect(withSubtitle!.candidate.tmdbId).toBe(438631);
    expect(withSubtitle!.tier).toBe('subtitle');
  });

  it('matches the same movie when release year differs by one', () => {
    const plusOne = findBestCatalogMatch('Parasite', 2020, catalog);
    expect(plusOne).not.toBeNull();
    expect(plusOne!.candidate.tmdbId).toBe(496243);
    expect(plusOne!.yearDiff).toBe(1);

    const minusOne = findBestCatalogMatch('Interstellar', 2013, catalog);
    expect(minusOne).not.toBeNull();
    expect(minusOne!.candidate.tmdbId).toBe(157336);
    expect(minusOne!.yearDiff).toBe(1);
  });

  it('disambiguates two different movies sharing the same title by year and rejects distant years', () => {
    const dune1984 = findBestCatalogMatch('Dune', 1984, catalog);
    expect(dune1984).not.toBeNull();
    expect(dune1984!.candidate.tmdbId).toBe(841);

    const dune2021 = findBestCatalogMatch('Dune', 2021, catalog);
    expect(dune2021).not.toBeNull();
    expect(dune2021!.candidate.tmdbId).toBe(438631);

    const nonMatchingYear = findBestCatalogMatch('Dune', 2005, catalog);
    expect(nonMatchingYear).toBeNull();
  });

  it('normalizes titles and extracts main part cleanly, including Latin diacritics without breaking Cyrillic', () => {
    expect(normalizeMovieTitle("Schindler's List: Special Edition")).toBe(
      'schindlers list special edition',
    );
    expect(normalizeMovieTitle('Amélie')).toBe('amelie');
    expect(normalizeMovieTitle('Бійцівський клуб')).toBe('бійцівський клуб');
    expect(normalizeMovieTitle('The Dark Knight', { stripArticles: true })).toBe('dark knight');
    expect(extractMainTitle('Dune: Part Two')).toBe('Dune');

    const amelieCatalog: CatalogMovieCandidate[] = [
      {
        id: 590,
        tmdbId: 194,
        title: 'Амелі',
        titleEn: 'Amélie',
        releaseDate: new Date('2001-04-25T00:00:00Z'),
        popularity: 18,
        voteCount: 11000,
      },
    ];
    const match = findBestCatalogMatch('Amelie', 2001, amelieCatalog);
    expect(match).not.toBeNull();
    expect(match!.candidate.tmdbId).toBe(194);
  });
});
