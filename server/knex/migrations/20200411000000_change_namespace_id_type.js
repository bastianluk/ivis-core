'use strict';

const em = require('../../lib/extension-manager');
const log = require('../../lib/log');
const array_async = require('../../lib/array-async-helpers');


exports.up = (knex, Promise) => (async () => {
//    await knex.raw('SET FOREIGN_KEY_CHECKS=0');

    // extension point expects an array of objects containing keys 'tableName' and 'columnName'. These tables/columns contain foreign keys pointing to namespaces.id
    // note that because ivis and extension migrations happen independently of each other (non-deterministically), some tables may not exist yet - we remove those from the list.
    let references = em.get('knex.table.namespaceReferences', []);

    // validation
    references.forEach(ref => {
        const keys = Object.keys(ref);
        if (keys.includes('tableName') && keys.includes('columnName'))
            return;

        const errorMsg = "The array in extension point 'knex.table.namespaceReferences' contains an object which lacks either 'tableName' or 'columnName' property. This is an error. Aborting migration"

        log.error('Migrations', `${errorMsg}\nProblematic object: ${JSON.stringify(ref)}`);
        throw errorMsg;
    })
    
    references = await array_async.filterAsync(references, async r => {
        return await knex.schema.hasTable(r.tableName);
    });

    const ivisReferences = ['namespaces', 'templates', 'jobs', 'tasks', 'workspaces', 'panels', 'signals', 'signal_sets', 'users'];
    ivisReferences.forEach(r => {
        references.push({
            tableName: r,
            columnName: 'namespace'
        });
    });
    
    async function updateVirt(id) {
        const virtObj = {
            name: 'Virtual',
            description: 'Virtual namespace',
            namespace: null
        };

        const oldId = (await knex.table('namespaces').where(virtObj).first()).id;

        await knex.table('namespaces').where(virtObj).update({id: id});

        for (const reference of references) {
            await knex.table(reference.tableName).where({
                [reference.columnName]: oldId
            }).update({[reference.columnName]: id});
        }
    }

    for (const reference of references) {
        await knex.schema.table(reference.tableName, table => {
            table.dropForeign(reference.columnName);
        });
    }
    await knex.schema.table('permissions_namespace', table => {
        table.dropForeign('entity');
    });
    await knex.schema.table('shares_namespace', table => {
        table.dropForeign('entity');
    });


    // Max signed int, otherwise alter will fail
    await updateVirt(2147483647);
    // No support for auto_increment on signed int type in knex
    await knex.schema.raw('ALTER TABLE `namespaces` MODIFY `id` int not null auto_increment;');

    for (const reference of references) {
        await knex.schema.alterTable(reference.tableName, table => {
            if (reference.tableName !== 'namespaces') {
                table.integer(reference.columnName).notNullable().references('namespaces.id').alter();
            } else {
                table.integer(reference.columnName).references('namespaces.id').alter();
            }
        });
    }
    await knex.schema.alterTable('shares_namespace', table => {
        table.integer('entity').notNullable().references(`namespaces.id`).onDelete('CASCADE').alter();
    });

    await knex.schema.alterTable('permissions_namespace', table => {
        table.integer('entity').notNullable().references(`namespaces.id`).onDelete('CASCADE').alter();
    });

    // New virtual namespace id
    await updateVirt(-1);


    const maxId =  await knex('namespaces').max('id as maxId').first();
    await knex.raw(`ALTER TABLE namespaces AUTO_INCREMENT=${maxId.maxId}`);

//    await knex.raw('SET FOREIGN_KEY_CHECKS=1');
})();

exports.down = (knex, Promise) => (async () => {
});