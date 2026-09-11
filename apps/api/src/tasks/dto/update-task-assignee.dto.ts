import { IsMongoId, ValidateIf } from 'class-validator';

export class UpdateTaskAssigneeDto {
  /**
   * The user to assign, or `null` to unassign. `null` is an explicit, valid
   * value here rather than "leave unchanged", so `ValidateIf` skips the id
   * check only when the caller genuinely sent null.
   */
  @ValidateIf((_, value) => value !== null)
  @IsMongoId()
  assigneeId: string | null;
}
