import { IsEnum, IsIn, IsOptional, IsString, IsInt, IsObject, MaxLength } from 'class-validator';
import type { RecommendationStrategy } from './recommendation-response.dto';

export class CreateRecommendationDto {
  @IsEnum(['quick_scenario', 'guided', 'free_text'])
  entryType: 'quick_scenario' | 'guided' | 'free_text';

  @IsOptional()
  @IsIn(['c1', 'c2', 'c3', 'rule_based'])
  strategy?: RecommendationStrategy;

  @IsOptional()
  @IsString()
  scenarioKey?: string;

  @IsOptional()
  @IsString()
  moodInput?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  freeTextPrompt?: string;

  @IsOptional()
  @IsInt()
  genreId?: number;

  @IsOptional()
  @IsInt()
  seedMovieId?: number;

  @IsOptional()
  @IsObject()
  refinements?: {
    lighter?: boolean;
    darker?: boolean;
    newer?: boolean;
    moreSerious?: boolean;
    lessRomantic?: boolean;
  };
}
