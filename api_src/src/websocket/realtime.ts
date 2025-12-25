/**
 * WebSocket 实时推送
 */

import { FastifyPluginAsync } from 'fastify';
import { PolymarketSDK } from '../../../src/index.js';
import { WebSocketManager } from '../../../src/clients/websocket-manager.js';
import { RealtimeService } from '../../../src/services/realtime-service.js';

const sdk = new PolymarketSDK();

export const realtimeRoutes: FastifyPluginAsync = async (fastify) => {
    // WebSocket 连接
    fastify.get('/market/:conditionId', { websocket: true }, async (connection, request) => {
        const { conditionId } = request.params as { conditionId: string };

        fastify.log.info(`WebSocket 连接: ${conditionId}`);

        try {
            // 获取市场详情
            const market = await sdk.getMarket(conditionId);
            const yesTokenId = market.tokens.yes.tokenId;
            const noTokenId = market.tokens.no.tokenId;

            // 发送初始数据
            connection.socket.send(JSON.stringify({
                type: 'init',
                data: {
                    market: {
                        conditionId,
                        question: market.question,
                        yesPrice: market.tokens.yes.price,
                        noPrice: market.tokens.no.price,
                    },
                },
            }));

            // 创建 WebSocket 订阅
            const wsManager = new WebSocketManager({ enableLogging: false });
            const realtime = new RealtimeService(wsManager);

            const subscription = await realtime.subscribeMarket(yesTokenId, noTokenId, {
                onPriceUpdate: (update) => {
                    connection.socket.send(JSON.stringify({
                        type: 'price',
                        data: update,
                    }));
                },
                onBookUpdate: (update) => {
                    connection.socket.send(JSON.stringify({
                        type: 'book',
                        data: {
                            assetId: update.assetId,
                            bestBid: update.bids[0],
                            bestAsk: update.asks[0],
                        },
                    }));
                },
                onLastTrade: (trade) => {
                    connection.socket.send(JSON.stringify({
                        type: 'trade',
                        data: trade,
                    }));
                },
                onPairUpdate: (update) => {
                    connection.socket.send(JSON.stringify({
                        type: 'pair',
                        data: {
                            yesPrice: update.yes.price,
                            noPrice: update.no.price,
                            spread: update.spread,
                            hasArb: update.spread < 0.99 || update.spread > 1.01,
                        },
                    }));
                },
                onError: (error) => {
                    connection.socket.send(JSON.stringify({
                        type: 'error',
                        data: { message: error.message },
                    }));
                },
            });

            // 处理断开连接
            connection.socket.on('close', async () => {
                fastify.log.info(`WebSocket 断开: ${conditionId}`);
                await subscription.unsubscribe();
            });

        } catch (error) {
            connection.socket.send(JSON.stringify({
                type: 'error',
                data: { message: (error as Error).message },
            }));
            connection.socket.close();
        }
    });
};
