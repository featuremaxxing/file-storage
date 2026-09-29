import { type EntityId } from '@shared/domain/types';
import { type ParentReference } from './parent-reference.interface';
import { type StorageLocation } from './storage-location.enum';

export interface ParentInfo extends ParentReference {
	storageLocationId: EntityId;
	storageLocation: StorageLocation;
	folderId?: EntityId | null;
}
