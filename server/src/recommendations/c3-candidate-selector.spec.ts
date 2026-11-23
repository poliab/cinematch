import {
  C3CatalogMovie,
  extractQueryConstraints,
  formatCandidatesForPrompt,
  selectCandidatesForC3,
} from './c3-candidate-selector';

describe('C3CandidateSelector', () => {
  const makeMovie = (
    id: number,
    title: string,
    titleEn: string,
    year: number,
    genreNames: string[],
    popularity = 20,
  ): C3CatalogMovie => ({
    id,
    tmdbId: 1000 + id,
    title,
    titleEn,
    releaseDate: new Date(`${year}-05-01T00:00:00Z`),
    voteAverage: 7.5,
    voteCount: 2000,
    popularity,
    genreNames,
  });

  const sampleCatalog: C3CatalogMovie[] = [
    makeMovie(1, 'Інтерстеллар', 'Interstellar', 2014, ['Фантастика', 'Драма', 'Пригоди'], 56),
    makeMovie(2, 'Матриця', 'The Matrix', 1999, ['Бойовик', 'Фантастика'], 45),
    makeMovie(3, 'Дюна', 'Dune', 2021, ['Фантастика', 'Пригоди'], 42),
    makeMovie(4, 'Суперперці', 'Superbad', 2007, ['Комедія'], 30),
    makeMovie(5, 'Кохання без правил', 'Romance Movie', 2018, ['Комедія', 'Мелодрама'], 35),
    makeMovie(6, 'Закляття', 'The Conjuring', 2013, ['Жахи', 'Трилер'], 38),
    makeMovie(7, 'Сім', 'Se7en', 1995, ['Трилер', 'Детектив', 'Кримінал'], 40),
    makeMovie(8, 'Останній дуель', 'Historical Non-War', 2021, ['Історичний', 'Драма'], 25),
    makeMovie(9, 'Врятувати рядового Раяна', 'Saving Private Ryan', 1998, ['Історичний', 'Військовий', 'Драма'], 48),
    makeMovie(10, 'Дуже дивний вестерн', 'Modern Western', 2022, ['Вестерн'], 15),
  ];

  it('extracts positive and negated genres without matching "драма" inside "мелодрама"', () => {
    const c = extractQueryConstraints(
      { freeTextPrompt: 'Комедія без романтики, краще щось динамічне' },
      sampleCatalog,
    );
    expect(c.requiredGenres).toEqual(['Комедія']);
    expect(c.excludedGenres).toEqual(['Мелодрама']);
  });

  it('extracts multiple excluded genres and bounded year ranges', () => {
    const c = extractQueryConstraints(
      { freeTextPrompt: 'Драма без комедії і без жахів, вийшла з 2010 по 2020 рік' },
      sampleCatalog,
    );
    expect(c.requiredGenres).toEqual(['Драма']);
    expect(c.excludedGenres).toEqual(expect.arrayContaining(['Комедія', 'Жахи']));
    expect(c.minYear).toBe(2010);
    expect(c.maxYear).toBe(2020);
  });

  it('does not treat a reference movie year ("Дюну 2021 року") as a minYear filter', () => {
    const c = extractQueryConstraints(
      { freeTextPrompt: 'Що є схожого на Дюну 2021 року' },
      sampleCatalog,
    );
    expect(c.minYear).toBeUndefined();
    expect(c.maxYear).toBeUndefined();
    expect(c.seedMovie?.tmdbId).toBe(1003);
    expect(c.softGenres).toEqual(expect.arrayContaining(['Фантастика', 'Пригоди']));
  });

  it('matches Ukrainian inflected seed titles ("Матриці") and excludes seed movie from candidates', () => {
    const res = selectCandidatesForC3(
      { freeTextPrompt: 'Хочу щось типу Матриці зі зламаною реальністю' },
      sampleCatalog,
      [],
      40,
      5,
    );
    expect(res.constraints.seedMovie?.tmdbId).toBe(1002);
    expect(res.candidates.some((m) => m.tmdbId === 1002)).toBe(false);
    // Sci-Fi/Action titles should rank above unrelated horror/western
    expect(res.candidates[0].genreNames).toContain('Фантастика');

    const withDirector = extractQueryConstraints(
      { freeTextPrompt: 'Дуже сподобався Інтерстеллар Нолана, порадьте щось у такому ж дусі' },
      sampleCatalog,
    );
    expect(withDirector.seedMovie?.tmdbId).toBe(1001);
  });

  it('strictly filters candidates when >= minPoolSize match and pads cleanly when narrow', () => {
    const bigCatalog = Array.from({ length: 45 }, (_, i) =>
      makeMovie(100 + i, `Комедія ${i}`, `Comedy ${i}`, 2019, ['Комедія'], 50 - i),
    ).concat([
      makeMovie(200, 'Романтична комедія', 'RomCom', 2020, ['Комедія', 'Мелодрама'], 99),
    ]);

    const res = selectCandidatesForC3(
      { freeTextPrompt: 'Комедія без романтики' },
      bigCatalog,
      [],
      40,
      30,
    );
    expect(res.strictMatchCount).toBe(45);
    expect(res.candidates).toHaveLength(40);
    expect(res.candidates.some((m) => m.tmdbId === 1200)).toBe(false);

    // Narrow query: only 1 western >= 2020 in sampleCatalog, still padded safely without horror if excluded
    const narrow = selectCandidatesForC3(
      { freeTextPrompt: 'Хочу вестерн, знятий не раніше 2020 року' },
      sampleCatalog,
      [],
      40,
      6,
    );
    expect(narrow.strictMatchCount).toBe(1);
    expect(narrow.candidates[0].tmdbId).toBe(1010);
    expect(narrow.candidates).toHaveLength(6);
  });

  it('formats candidate lines compactly with ID, titles, year, and genres', () => {
    const text = formatCandidatesForPrompt([sampleCatalog[0]]);
    expect(text).toBe('1001 | Інтерстеллар / Interstellar (2014) [Фантастика, Драма, Пригоди]');
  });
});
