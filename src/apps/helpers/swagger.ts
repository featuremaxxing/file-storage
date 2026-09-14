import { type INestApplication } from '@nestjs/common';
import { DocumentBuilder, type SwaggerDocumentOptions, SwaggerModule } from '@nestjs/swagger';

const config = new DocumentBuilder()
	.addServer('/api/v3/') // add default path as server to have correct urls ald let 'try out' work
	.setTitle('Schulcloud-Verbund-Software File Storage API (featuremaxxing)')
	.setDescription('This is the API documentation for the Schulcloud-Verbund-Software File Storage API')
	.setVersion('3.0')
	/** set authentication for all routes enabled by default */
	.addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
	.build();

export const enableOpenApiDocs = (app: INestApplication, path: string, options?: SwaggerDocumentOptions): void => {
	const document = SwaggerModule.createDocument(app, config, {
		...options,
		operationIdFactory: (_controllerKey: string, methodKey: string) => methodKey,
	});
	SwaggerModule.setup(path, app, document);
};
