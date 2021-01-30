'use strict';
const {SignalType} = require('../../shared/signals');
const config = require('./config');
const indexer = require('./indexers/' + config.indexer);
// TODO check if there is also some default limiting in es
const MAX_RESULTS_WINDOW = config.elasticsearch.maxResultsWindow;

/**
 * Create input for signal ES query from DT params.
 * Query is acceptable by
 * @param sigSet
 * @param signals
 * @param params
 * @returns {{sigSetCid: *}}
 */
function toQuery(sigSet, signals, params) {
    const columns = [...signals.map(sig => sig.cid)];

    const query = {
        sigSetCid: sigSet.cid,
        params: {}
    };

    if (params.search.value !== '') {

        const strValue = '*' + params.search.value + '*';

        const filter = {
            type: 'or'
        };


        filter.children = [];

        // zero is ID column which doesn't have sigCid
        for (let i = 1; i < params.columns.length; i++) {

            if (params.columns[i].searchable !== true) {
                continue;
            }

            // search allowed only on these types as there is no easy way to do in similarly on other types in ES
            if (signals[i - 1].type === SignalType.TEXT || signals[i - 1].type === SignalType.KEYWORD) {
                filter.children.push({
                    type: 'wildcard',
                    sigCid: columns[i - 1],
                    value: strValue
                });
            }
        }

        if (filter.children.length > 0) {
            query.filter = filter;
        }
    }

    const docs = {
        limit: params.length,
        from: params.start,
        signals: columns
    };

    const sort = [];

    // docSort is used for auto generated ids, because they don't have id field, therefore would be imposisble
    // to sort them, so it fallbacks on _doc sort and lowers priority
    let docSort = null;
    for (const order of params.order) {
        if (order.column === 0) {
            sort.push({
                field: 'id',
                order: order.dir
            });

            docSort = {
                field: '_doc',
                order: order.dir
            };
        } else {
            sort.push({
                // columns are without id therefore shifted by 1
                sigCid: columns[order.column - 1],
                order: order.dir
            });
        }
    }

    if (docSort) {
        sort.push(docSort);
    }

    docs.sort = sort;
    query.docs = docs;
    query.params.withId = true;
    return query;
}

/**
 *
 * @param queryResult
 * @param signals
 * @return Object {total: <Total number of documents>, data: <Batch of data from query>}
 */
function fromQueryResultToDTFormat(queryResult, signals) {
    const result = {};
    const data = [];
    for (let doc of queryResult.docs) {
        const record = [];
        record.push(doc['_id']);
        for (let signal of signals) {
            record.push(doc[signal.cid]);
        }
        data.push(record);
    }
    result.data = data;
    result.total = queryResult.total;

    return result;
}

async function fromQueryResultToDTInput(queryResult, sigSet, signals, params) {
        const result = {
            draw: params.draw,
        };

        const res = fromQueryResultToDTFormat(queryResult[0], signals);

        result.recordsTotal = await indexer.getDocsCount(sigSet);
        // Prevents deep pagination in GUI
        result.recordsFiltered = res.total < MAX_RESULTS_WINDOW ? res.total : MAX_RESULTS_WINDOW;

        result.data = res.data;

        return result;
}

module.exports.toQuery = toQuery;
module.exports.fromQueryResultToDTInput = fromQueryResultToDTInput;
module.exports.fromQueryResultToDTFormat = fromQueryResultToDTFormat;
module.exports.MAX_RESULTS_WINDOW = MAX_RESULTS_WINDOW;
