import { Embedded, Entity, Enum, Index, Property } from '@mikro-orm/mongodb';
import { BaseEntityWithTimestamps } from '@shared/domain/entity';
import { EntityId } from '@shared/domain/types';
import { ObjectIdType } from '@shared/repo/types/object-id.type';
import { FileRecord, FileRecordProps, FolderExpirationDays, StorageType } from '../domain';
import { FileRecordParentType, StorageLocation } from '../domain/interface';
import { FileRecordSecurityCheckEmbeddable } from './security-check.embeddable';

const SECONDS_PER_DAY = 24 * 60 * 60;
/**
 * Note: The file record entity will not manage any entity relations by itself.
 * That's why we do not map any relations in the entity class
 * and instead just use the plain object ids.
 */
@Entity({ tableName: 'filerecords' })
@Index({ properties: ['storageLocation', 'storageLocationId'], options: { background: true } })
// https://github.com/mikro-orm/mikro-orm/issues/1230
@Index({ options: { 'securityCheck.requestToken': 1 } })
@Index({
	name: 'isUploading_ttl_idx',
	properties: ['createdAt'],
	options: {
		expireAfterSeconds: 3600,
		partialFilterExpression: { isUploading: true },
	},
})
@Index({
	name: 'temp_file_ttl_idx',
	properties: ['createdAt'],
	options: {
		expireAfterSeconds: FolderExpirationDays[StorageType.TEMP] * SECONDS_PER_DAY,
		partialFilterExpression: { storageType: StorageType.TEMP },
	},
})
export class FileRecordEntity extends BaseEntityWithTimestamps implements FileRecordProps {
	@Index({ options: { expireAfterSeconds: FolderExpirationDays.TRASH * SECONDS_PER_DAY } })
	@Property({ nullable: true })
	deletedSince?: Date;

	@Property({ nullable: true })
	contentLastModifiedAt?: Date;

	@Property()
	size!: number;

	@Property()
	name!: string;

	@Property()
	mimeType!: string;

	@Embedded(() => FileRecordSecurityCheckEmbeddable, { object: true, nullable: false })
	securityCheck!: FileRecordSecurityCheckEmbeddable;

	@Index()
	@Enum(() => FileRecordParentType)
	parentType!: FileRecordParentType;

	@Property({ nullable: true })
	isUploading?: boolean;

	@Property({ nullable: true })
	previewGenerationFailed?: boolean;

	@Index()
	@Property({ type: ObjectIdType, fieldName: 'parent', nullable: false })
	parentId!: EntityId;

	@Index()
	@Property({ type: ObjectIdType, fieldName: 'creator', nullable: true })
	creatorId?: EntityId;

	@Property({ type: ObjectIdType, fieldName: 'storageLocationId', nullable: false })
	storageLocationId!: EntityId;

	@Property({ type: 'StorageLocation' })
	storageLocation!: StorageLocation;

	@Property({ type: ObjectIdType, fieldName: 'isCopyFrom', nullable: true })
	isCopyFrom?: EntityId;

	@Property({ nullable: true })
	isFolder?: boolean;

	@Index()
	@Property({ type: ObjectIdType, fieldName: 'folder', nullable: true })
	folderId?: EntityId | null;

	@Property({ persist: false })
	domainObject: FileRecord | undefined;

	@Enum({ items: () => StorageType, nullable: false })
	storageType!: StorageType;
}
