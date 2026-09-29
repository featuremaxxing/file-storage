import { MongoPlatform, ObjectId, type Platform, Type } from '@mikro-orm/mongodb';
import { type EntityId } from '@shared/domain/types';

export class ObjectIdType extends Type<EntityId, ObjectId> {
	public convertToDatabaseValue(value: EntityId, platform: Platform): ObjectId {
		this.validatePlatformSupport(platform);

		// `new ObjectId(value)` generates a brand-new random id when value is null/undefined
		// instead of passing it through - this only matters once a property using this type is
		// ever queried by null (e.g. FileRecordEntity.folderId for "root level"), since every
		// other consumer of this type always deals with real ids. Without this guard, a query
		// like `{ folder: null }` silently turns into `{ folder: <random id> }` and matches
		// nothing.
		if (value === null || value === undefined) {
			return value as unknown as ObjectId;
		}

		return new ObjectId(value);
	}

	public convertToJSValue(value: ObjectId, platform: Platform): EntityId {
		this.validatePlatformSupport(platform);

		return value.toHexString();
	}

	private validatePlatformSupport(platform: Platform): void {
		if (!(platform instanceof MongoPlatform)) {
			throw new Error('ObjectId custom type implemented only for Mongo.');
		}
	}
}
