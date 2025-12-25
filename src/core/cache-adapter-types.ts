/**
 * Cache Adapter Interface (Local Definition)
 * 
 * 本地定义的缓存适配器接口，用于独立运行 SDK
 * 原始接口来自 @catalyst-team/cache 包
 */

/**
 * 缓存适配器接口
 * 支持任何后端存储（内存、Redis 等）
 */
export interface CacheAdapter {
    /**
     * 获取缓存值
     * @param key 缓存键
     * @returns 缓存值或 null（如果不存在或过期）
     */
    get<T>(key: string): Promise<T | null>;

    /**
     * 设置缓存值
     * @param key 缓存键
     * @param value 要缓存的值
     * @param ttl 可选的 TTL（秒）
     */
    set<T>(key: string, value: T, ttl?: number): Promise<void>;

    /**
     * 删除缓存键
     * @param key 要删除的键
     */
    del(key: string): Promise<void>;

    /**
     * 检查键是否存在
     * @param key 要检查的键
     */
    exists(key: string): Promise<boolean>;

    /**
     * 清空所有缓存
     */
    clear?(): Promise<void>;
}
