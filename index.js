const http = require('http');
const messy = require('messy');
const expect = require('unexpected')
    .clone()
    .use(require('unexpected-messy'));

var expectWithoutFootgunProtection = expect.clone();
// Disable the footgun protection of our Unexpected clone:
expectWithoutFootgunProtection.notifyPendingPromise = function () {};

var mockDefinitionForTheCurrentTest;
var resolveNext;
var promiseForAfterEach;
var afterEachRegistered = false;
function ensureAfterEachIsRegistered() {
    if (!afterEachRegistered && typeof afterEach === 'function') {
        afterEachRegistered = true;
        afterEach(function () {
            if (resolveNext) {
                resolveNext();
                resolveNext = undefined;
                return promiseForAfterEach
                    .finally(() => mockDefinitionForTheCurrentTest = undefined);
            } else {
                mockDefinitionForTheCurrentTest = undefined;
            }
        });
    }
}

// When running in jasmine/node.js, afterEach is available immediately,
// but doesn't work within the it block. Register the hook immediately:
ensureAfterEachIsRegistered();

function createMockResponse(responseProperties) {
    var mockResponse = new messy.HttpResponse(responseProperties);
    mockResponse.statusCode = mockResponse.statusCode || 200;
    mockResponse.protocolName = mockResponse.protocolName || 'HTTP';
    mockResponse.protocolVersion = mockResponse.protocolVersion || '1.1';
    mockResponse.statusMessage = mockResponse.statusMessage || http.STATUS_CODES[mockResponse.statusCode];
    return mockResponse;
}

// function createErrorResponse() {
//     const response = new global.Response(null, {status: 0, statusText: ''});
//     response.type = 'error';
//     return response;
// }

function createActualRequestModel(url, opts) {
    const requestOptions = Object.assign({ url, method: 'GET' }, opts);
    return new messy.HttpRequest(requestOptions);
};

function verifyRequest(actualRequest, expectedRequest) {
    // Handle potential oathbreaking of the assertion.
    var promise;
    try {
        promise = expect(actualRequest, 'to satisfy', expectedRequest);
    } catch (e) {
        promise = Promise.reject(e);
    }
    return promise;
}


function verifyConversation(expectedExchanges, actualConversation, err) {
    return expect(actualConversation, 'to satisfy', {
        exchanges: expectedExchanges
    }).then(() => {
        if (err) {
            // The conversations matched so we will rethrow the error
            throw err;
        }
    });
}

function fetchception(expectedExchanges, promiseFactory) {
    // When the caller left out the expectedExchanges assume they meant []
    if (
        typeof promiseFactory === 'undefined' &&
        typeof expectedExchanges === 'function'
    ) {
        promiseFactory = expectedExchanges;
        expectedExchanges = [];
    }

    // Allow passing a single exchange pair without wrapping it in an object.
    if (
        expectedExchanges &&
        typeof expectedExchanges === 'object' &&
        !Array.isArray(expectedExchanges)
    ) {
        expectedExchanges = [expectedExchanges];
    }

    if (mockDefinitionForTheCurrentTest) {
        Array.prototype.push.apply(mockDefinitionForTheCurrentTest, expectedExchanges);
    } else {
        mockDefinitionForTheCurrentTest = expectedExchanges;
    }

    const originalFetch = global.fetch;
    const restoreFetch = () => global.fetch = originalFetch;
    const httpConversation = new messy.HttpConversation();

    var exchangeIndex = 0;
    function getNextExchange() {
        const exchange = mockDefinitionForTheCurrentTest[exchangeIndex] || {};
        exchangeIndex += 1;
        return {
            request: exchange.request,
            response: exchange.response
        };
    }

    global.fetch = (url, opts) => {
        const currentExchange = getNextExchange();
        const actualRequest = createActualRequestModel(url, opts);
        const mockResponse = createMockResponse(currentExchange.response);

        var responseBody = mockResponse.decodedBody;

        if (responseBody && typeof responseBody === 'object') {
            responseBody = JSON.stringify(responseBody);
            mockResponse.headers.set('Content-Type', 'application/json');
        }

        return verifyRequest(actualRequest, currentExchange.request).then(
            res => {


                httpConversation.exchanges.push(new messy.HttpExchange({
                    request: actualRequest,
                    response: mockResponse
                }));

                const response = new global.Response(responseBody, {
                    status: mockResponse.statusLine.statusCode,
                    statusText: mockResponse.statusLine.statusMessage,
                    headers: mockResponse.headers.valuesByName
                });

                return response;
            },
            () => {
                // the request didn't match, so we create a failing response to
                // break the code asap
                const error = new TypeError('Network request failed');

                httpConversation.exchanges.push(new messy.HttpExchange({
                    request: actualRequest,
                    response: mockResponse
                }));

                throw error;
            }
        );
    };

    if (promiseFactory) {
        const promise = promiseFactory(); // TODO: handle throws

        if (!promise || typeof promise.then !== 'function') {
            restoreFetch();
            throw new Error('fetchception: You must return a promise from the supplied function.');
        }
        resolveNext = false;
        return expect.promise(() => promise)
            .then(
                () => verifyConversation(mockDefinitionForTheCurrentTest, httpConversation),
                (err) => verifyConversation(mockDefinitionForTheCurrentTest, httpConversation, err)
            )
            .finally(() => restoreFetch());
    } else {
        promiseForAfterEach = expectWithoutFootgunProtection(function () {
            return expect.promise((resolve, reject) => {
                resolveNext = resolve;
            });
        }, 'not to error').then(
            () => verifyConversation(mockDefinitionForTheCurrentTest, httpConversation)
        )
        .finally(() => restoreFetch());
    }
}

module.exports = fetchception;

// Expose the internal unexpected instance.
module.exports.expect = expect;
