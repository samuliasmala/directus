/**
 * Generate an AST based on a given collection and query
 */

import {
	AST,
	NestedCollectionNode,
	FieldNode,
	Query,
	Relation,
	PermissionsAction,
	Accountability,
	SchemaOverview,
} from '../types';
import database from '../database';
import { cloneDeep } from 'lodash';
import Knex from 'knex';
import { getRelationType } from '../utils/get-relation-type';
import { systemFieldRows } from '../database/system-data/fields';
import { systemRelationRows } from '../database/system-data/relations';

type GetASTOptions = {
	accountability?: Accountability | null;
	action?: PermissionsAction;
	knex?: Knex;
};

type anyNested = {
	[collectionScope: string]: string[];
};

export default async function getASTFromQuery(
	collection: string,
	query: Query,
	schema: SchemaOverview,
	options?: GetASTOptions
): Promise<AST> {
	query = cloneDeep(query);

	const accountability = options?.accountability;
	const action = options?.action || 'read';
	const knex = options?.knex || database;

	/**
	 * we might not need al this info at all times, but it's easier to fetch it all once, than trying to fetch it for every
	 * requested field. @todo look into utilizing graphql/dataloader for this purpose
	 */
	const relations = [
		...(await knex.select<Relation[]>('*').from('directus_relations')),
		...systemRelationRows,
	];

	const permissions =
		accountability && accountability.admin !== true
			? await knex
					.select<{ collection: string; fields: string }[]>('collection', 'fields')
					.from('directus_permissions')
					.where({ role: accountability.role, action: action })
			: null;

	const ast: AST = {
		type: 'root',
		name: collection,
		query: query,
		children: [],
	};

	const fields = query.fields || ['*'];
	const deep = query.deep || {};

	// Prevent fields/deep from showing up in the query object in further use
	delete query.fields;
	delete query.deep;

	ast.children = await parseFields(collection, fields, deep);

	return ast;

	async function parseFields(
		parentCollection: string,
		fields: string[] | null,
		deep?: Record<string, Query>
	) {
		if (!fields) return [];

		fields = await convertWildcards(parentCollection, fields);

		if (!fields) return [];

		const children: (NestedCollectionNode | FieldNode)[] = [];

		const relationalStructure: Record<string, string[] | anyNested> = {};

		for (const field of fields) {
			const isRelational =
				field.includes('.') ||
				// We'll always treat top level o2m fields as a related item. This is an alias field, otherwise it won't return
				// anything
				!!relations.find(
					(relation) =>
						relation.one_collection === parentCollection && relation.one_field === field
				);

			if (isRelational) {
				// field is relational
				const parts = field.split('.');

				let fieldKey = parts[0];
				let collectionScope: string | null = null;

				// m2a related collection scoped field selector `fields=sections.section_id:headings.title`
				if (fieldKey.includes(':')) {
					const [key, scope] = fieldKey.split(':');
					fieldKey = key;
					collectionScope = scope;
				}

				if (relationalStructure.hasOwnProperty(fieldKey) === false) {
					if (collectionScope) {
						relationalStructure[fieldKey] = { [collectionScope]: [] };
					} else {
						relationalStructure[fieldKey] = [];
					}
				}

				if (parts.length > 1) {
					const childKey = parts.slice(1).join('.');

					if (collectionScope) {
						if (collectionScope in relationalStructure[fieldKey] === false) {
							(relationalStructure[fieldKey] as anyNested)[collectionScope] = [];
						}

						(relationalStructure[fieldKey] as anyNested)[collectionScope].push(
							childKey
						);
					} else {
						(relationalStructure[fieldKey] as string[]).push(childKey);
					}
				}
			} else {
				children.push({ type: 'field', name: field });
			}
		}

		for (const [relationalField, nestedFields] of Object.entries(relationalStructure)) {
			const relatedCollection = getRelatedCollection(parentCollection, relationalField);
			const relation = getRelation(parentCollection, relationalField);

			if (!relation) continue;

			const relationType = getRelationType({
				relation,
				collection: parentCollection,
				field: relationalField,
			});

			if (!relationType) continue;

			let child: NestedCollectionNode | null = null;

			if (relationType === 'm2a') {
				const allowedCollections = relation
					.one_allowed_collections!.split(',')
					.filter((collection) => {
						if (!permissions) return true;
						return permissions.some(
							(permission) => permission.collection === collection
						);
					});

				child = {
					type: 'm2a',
					names: allowedCollections,
					children: {},
					query: {},
					relatedKey: {},
					parentKey: schema[parentCollection].primary,
					fieldKey: relationalField,
					relation: relation,
				};

				for (const relatedCollection of allowedCollections) {
					child.children[relatedCollection] = await parseFields(
						relatedCollection,
						Array.isArray(nestedFields)
							? nestedFields
							: (nestedFields as anyNested)[relatedCollection] || ['*']
					);
					child.query[relatedCollection] = {};
					child.relatedKey[relatedCollection] = schema[relatedCollection].primary;
				}
			} else if (relatedCollection) {
				if (
					permissions &&
					permissions.some(
						(permission) => permission.collection === relatedCollection
					) === false
				) {
					continue;
				}

				child = {
					type: relationType,
					name: relatedCollection,
					fieldKey: relationalField,
					parentKey: schema[parentCollection].primary,
					relatedKey: schema[relatedCollection].primary,
					relation: relation,
					query: deep?.[relationalField] || {},
					children: await parseFields(relatedCollection, nestedFields as string[]),
				};
			}

			if (child) {
				children.push(child);
			}
		}

		return children;
	}

	async function convertWildcards(parentCollection: string, fields: string[]) {
		fields = cloneDeep(fields);

		const fieldsInCollection = await getFieldsInCollection(parentCollection);

		const allowedFields = permissions
			? permissions
					.find((permission) => parentCollection === permission.collection)
					?.fields?.split(',')
			: fieldsInCollection;

		if (!allowedFields || allowedFields.length === 0) return [];

		for (let index = 0; index < fields.length; index++) {
			const fieldKey = fields[index];

			if (fieldKey.includes('*') === false) continue;

			if (fieldKey === '*') {
				console.log(allowedFields);
				// Set to all fields in collection
				if (allowedFields.includes('*')) {
					fields.splice(index, 1, ...fieldsInCollection);
				} else {
					// Set to all allowed fields
					fields.splice(index, 1, ...allowedFields);
				}
			}

			// Swap *.* case for *,<relational-field>.*,<another-relational>.*
			if (fieldKey.includes('.') && fieldKey.split('.')[0] === '*') {
				const parts = fieldKey.split('.');

				const relationalFields = allowedFields.includes('*')
					? relations
							.filter(
								(relation) =>
									relation.many_collection === parentCollection ||
									relation.one_collection === parentCollection
							)
							.map((relation) => {
								const isMany = relation.many_collection === parentCollection;
								return isMany ? relation.many_field : relation.one_field;
							})
					: allowedFields.filter((fieldKey) => !!getRelation(parentCollection, fieldKey));

				const nonRelationalFields = allowedFields.filter(
					(fieldKey) => relationalFields.includes(fieldKey) === false
				);

				fields.splice(
					index,
					1,
					...[
						...relationalFields.map((relationalField) => {
							return `${relationalField}.${parts.slice(1).join('.')}`;
						}),
						...nonRelationalFields,
					]
				);
			}
		}

		return fields;
	}

	function getRelation(collection: string, field: string) {
		const relation = relations.find((relation) => {
			return (
				(relation.many_collection === collection && relation.many_field === field) ||
				(relation.one_collection === collection && relation.one_field === field)
			);
		});

		return relation;
	}

	function getRelatedCollection(collection: string, field: string): string | null {
		const relation = getRelation(collection, field);

		if (!relation) return null;

		if (relation.many_collection === collection && relation.many_field === field) {
			return relation.one_collection || null;
		}

		if (relation.one_collection === collection && relation.one_field === field) {
			return relation.many_collection || null;
		}

		return null;
	}

	async function getFieldsInCollection(collection: string) {
		const columns = Object.keys(schema[collection].columns);
		const fields = [
			...(await knex.select('field').from('directus_fields').where({ collection })).map(
				(field) => field.field
			),
			...systemFieldRows
				.filter((fieldMeta) => fieldMeta.collection === collection)
				.map((fieldMeta) => fieldMeta.field),
		];

		const fieldsInCollection = [
			...columns,
			...fields.filter((field) => {
				return columns.includes(field) === false;
			}),
		];

		return fieldsInCollection;
	}
}
