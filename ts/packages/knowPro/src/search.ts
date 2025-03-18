// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { MessageAccumulator, SemanticRefAccumulator } from "./collections.js";
import { DateTimeRange } from "./dateTimeSchema.js";
import {
    DateRange,
    IConversation,
    KnowledgeType,
    ScoredKnowledge,
    ScoredSemanticRefOrdinal,
    SemanticRef,
    Term,
    IConversationSecondaryIndexes,
    ScoredMessageOrdinal,
} from "./interfaces.js";
import { mergedEntities, mergeTopics } from "./knowledge.js";
import { isMessageTextEmbeddingIndex } from "./messageIndex.js";
import * as q from "./query.js";
import { IQueryOpExpr } from "./query.js";
import { resolveRelatedTerms } from "./relatedTermsIndex.js";
import { conversation as kpLib } from "knowledge-processor";

export type SearchTerm = {
    /**
     * Term being searched for
     */
    term: Term;
    /**
     * Additional terms related to term.
     * These can be supplied from synonym tables and so on
     */
    relatedTerms?: Term[] | undefined;
};

/**
 * A Group of search terms
 */
export type SearchTermGroup = {
    /**
     * And will enforce that all terms match
     */
    booleanOp: "and" | "or";
    terms: (SearchTerm | PropertySearchTerm)[];
};

/**
 * Well known knowledge properties
 */
export type KnowledgePropertyName =
    | "name" // the name of an entity
    | "type" // the type of an entity
    | "verb" // the verb of an action
    | "subject" // the subject of an action
    | "object" // the object of an action
    | "indirectObject" // The indirectObject of an action
    | "tag"; // Tag

export type PropertySearchTerm = {
    /**
     * PropertySearch terms let you matched named property, values
     * - You can  match a well known property name (name("Bach") type("book"))
     * - Or you can provide a SearchTerm as a propertyName.
     *   E.g. to match hue(red)
     *      - propertyName as SearchTerm, set to 'hue'
     *      - propertyValue as SearchTerm, set to 'red'
     * SearchTerms can included related terms
     *   E.g you could include "color" as a related term for the propertyName "hue". Or 'crimson' for red.
     * The the query processor can also related terms using a related terms secondary index, if one is available
     */
    propertyName: KnowledgePropertyName | SearchTerm;
    propertyValue: SearchTerm;
};

export function createSearchTerm(text: string, score?: number): SearchTerm {
    return {
        term: {
            text,
            weight: score,
        },
    };
}

export function createPropertySearchTerm(
    key: string,
    value: string,
): PropertySearchTerm {
    let propertyName: KnowledgePropertyName | SearchTerm;
    let propertyValue: SearchTerm;
    switch (key) {
        default:
            propertyName = createSearchTerm(key);
            break;
        case "name":
        case "type":
        case "verb":
        case "subject":
        case "object":
        case "indirectObject":
        case "tag":
            propertyName = key;
            break;
    }
    propertyValue = createSearchTerm(value);
    return { propertyName, propertyValue };
}

export type WhenFilter = {
    knowledgeType?: KnowledgeType | undefined;
    dateRange?: DateRange | undefined;
    threadDescription?: string | undefined;
};

export function createWhenFilterForDateTimeRange(
    dateTimeRange?: DateTimeRange | undefined,
): WhenFilter {
    const when: WhenFilter = {};
    if (dateTimeRange) {
        when.dateRange = dateRangeFromDateTimeRange(dateTimeRange);
    }
    return when;
}

export function dateRangeFromDateTimeRange(
    dateTimeRange: DateTimeRange,
): DateRange {
    return {
        start: kpLib.toStartDate(dateTimeRange.startDate),
        end: kpLib.toStopDate(dateTimeRange.stopDate),
    };
}

export type SearchOptions = {
    maxKnowledgeMatches?: number | undefined;
    exactMatch?: boolean | undefined;
    usePropertyIndex?: boolean | undefined;
    useTimestampIndex?: boolean | undefined;
    maxMessageMatches?: number | undefined;
    maxMessageCharsInBudget?: number | undefined;
};

export type SemanticRefSearchResult = {
    termMatches: Set<string>;
    semanticRefMatches: ScoredSemanticRefOrdinal[];
};

export type ConversationSearchResult = {
    messageMatches: ScoredMessageOrdinal[];
    knowledgeMatches: Map<KnowledgeType, SemanticRefSearchResult>;
};

/**
 * Search a conversation for messages and knowledge that match the supplied search terms
 * @param conversation Conversation to search
 * @param searchTermGroup a group of search terms to match
 * @param filter conditional filter to scope what messages and knowledge are matched
 * @param options search options
 * @returns
 */
export async function searchConversation(
    conversation: IConversation,
    searchTermGroup: SearchTermGroup,
    filter?: WhenFilter,
    options?: SearchOptions,
    rawSearchQuery?: string,
): Promise<ConversationSearchResult | undefined> {
    const knowledgeMatches = await searchConversationKnowledge(
        conversation,
        searchTermGroup,
        filter,
        options,
    );
    if (!knowledgeMatches) {
        return undefined;
    }
    // Future: Combine knowledge and message queries into single query tree
    const queryBuilder = new QueryCompiler(
        conversation,
        conversation.secondaryIndexes ?? {},
    );
    const query = await queryBuilder.compileMessageQuery(
        knowledgeMatches,
        options,
        rawSearchQuery,
    );
    const messageMatches: ScoredMessageOrdinal[] = runQuery(
        conversation,
        options,
        query,
    );
    return {
        messageMatches,
        knowledgeMatches,
    };
}

/**
 * Search a conversation for knowledge that matches the given search terms
 * @param conversation Conversation to search
 * @param searchTermGroup a group of search terms to match
 * @param filter conditional filter to scope what messages and knowledge are matched
 * @param options search options
 * @returns
 */
export async function searchConversationKnowledge(
    conversation: IConversation,
    searchTermGroup: SearchTermGroup,
    filter?: WhenFilter,
    options?: SearchOptions,
): Promise<Map<KnowledgeType, SemanticRefSearchResult> | undefined> {
    if (!q.isConversationSearchable(conversation)) {
        return undefined;
    }
    const queryBuilder = new QueryCompiler(
        conversation,
        conversation.secondaryIndexes ?? {},
    );
    const query = await queryBuilder.compileKnowledgeQuery(
        searchTermGroup,
        filter,
        options,
    );
    return runQuery(conversation, options, query);
}

export function getDistinctEntityMatches(
    semanticRefs: SemanticRef[],
    searchResults: ScoredSemanticRefOrdinal[],
    topK?: number,
): ScoredKnowledge[] {
    return mergedEntities(semanticRefs, searchResults, topK);
}

export function getDistinctTopicMatches(
    semanticRefs: SemanticRef[],
    searchResults: ScoredSemanticRefOrdinal[],
    topK?: number,
): ScoredKnowledge[] {
    return mergeTopics(semanticRefs, searchResults, topK);
}

function runQuery<T = any>(
    conversation: IConversation,
    options: SearchOptions | undefined,
    query: IQueryOpExpr<T>,
): T {
    const secondaryIndexes: IConversationSecondaryIndexes =
        conversation.secondaryIndexes ?? {};
    return query.eval(
        new q.QueryEvalContext(
            conversation,
            options?.usePropertyIndex
                ? secondaryIndexes.propertyToSemanticRefIndex
                : undefined,
            options?.useTimestampIndex
                ? secondaryIndexes.timestampIndex
                : undefined,
        ),
    );
}

class QueryCompiler {
    // All SearchTerms used which compiling the 'select' portion of the query
    private allSearchTerms: SearchTerm[] = [];
    // All search terms used while compiling predicates in the query
    private allPredicateSearchTerms: SearchTerm[] = [];
    private allScopeSearchTerms: SearchTerm[] = [];

    constructor(
        public conversation: IConversation,
        public secondaryIndexes?: IConversationSecondaryIndexes | undefined,
        public entityTermMatchWeight: number = 100,
        public defaultTermMatchWeight: number = 10,
        public relatedIsExactThreshold: number = 0.95,
    ) {}

    public async compileKnowledgeQuery(
        terms: SearchTermGroup,
        filter?: WhenFilter,
        options?: SearchOptions,
    ) {
        let query = await this.compileQuery(terms, filter, options);

        const exactMatch = options?.exactMatch ?? false;
        if (!exactMatch) {
            // For all individual SearchTerms created during query compilation, resolve any related terms
            await this.resolveRelatedTerms(this.allSearchTerms, true);
            await this.resolveRelatedTerms(this.allPredicateSearchTerms, false);
            await this.resolveRelatedTerms(this.allScopeSearchTerms, false);
        }

        return new q.GroupSearchResultsExpr(query);
    }

    public async compileMessageQuery(
        knowledge:
            | IQueryOpExpr<Map<KnowledgeType, SemanticRefSearchResult>>
            | Map<KnowledgeType, SemanticRefSearchResult>,
        options?: SearchOptions,
        rawQueryText?: string,
    ): Promise<IQueryOpExpr> {
        let query: IQueryOpExpr = new q.MessagesFromKnowledgeExpr(knowledge);
        if (options) {
            query = await this.compileMessageReRank(
                query,
                rawQueryText,
                options.maxMessageMatches,
            );
            if (
                options.maxMessageCharsInBudget &&
                options.maxMessageCharsInBudget > 0
            ) {
                query = new q.SelectMessagesInCharBudget(
                    query,
                    options.maxMessageCharsInBudget,
                );
            }
        }
        query = new q.GetScoredMessages(query);
        return query;
    }

    private async compileQuery(
        searchTermGroup: SearchTermGroup,
        filter?: WhenFilter,
        options?: SearchOptions,
    ): Promise<IQueryOpExpr<Map<KnowledgeType, SemanticRefAccumulator>>> {
        let selectExpr = this.compileSelect(
            searchTermGroup,
            await this.compileScope(searchTermGroup, filter),
            options,
        );
        // Constrain the select with scopes and 'where'
        if (filter) {
            selectExpr = new q.WhereSemanticRefExpr(
                selectExpr,
                this.compileWhere(filter),
            );
        }
        // And lastly, select 'TopN' and group knowledge by type
        return new q.SelectTopNKnowledgeGroupExpr(
            new q.GroupByKnowledgeTypeExpr(selectExpr),
            options?.maxKnowledgeMatches,
        );
    }

    private compileSelect(
        termGroup: SearchTermGroup,
        scopeExpr?: q.GetScopeExpr,
        options?: SearchOptions,
    ) {
        // Select is a combination of ordinary search terms and property search terms
        let [searchTermUsed, selectExpr] = this.compileSearchGroup(
            termGroup,
            scopeExpr,
        );
        this.allSearchTerms.push(...searchTermUsed);
        return selectExpr;
    }

    private compileSearchGroup(
        searchGroup: SearchTermGroup,
        scopeExpr?: q.GetScopeExpr,
    ): [SearchTerm[], q.IQueryOpExpr<SemanticRefAccumulator>] {
        const searchTermsUsed: SearchTerm[] = [];
        const termExpressions: q.MatchTermExpr[] = [];
        for (const term of searchGroup.terms) {
            if (isPropertyTerm(term)) {
                termExpressions.push(new q.MatchPropertySearchTermExpr(term));
                if (typeof term.propertyName !== "string") {
                    searchTermsUsed.push(term.propertyName);
                }
                if (isEntityPropertyTerm(term)) {
                    term.propertyValue.term.weight ??=
                        this.entityTermMatchWeight;
                }
                searchTermsUsed.push(term.propertyValue);
            } else {
                termExpressions.push(
                    new q.MatchSearchTermExpr(term, (term, sr, scored) =>
                        this.boostEntities(term, sr, scored, 10),
                    ),
                );
                searchTermsUsed.push(term);
            }
        }
        return [
            searchTermsUsed,
            searchGroup.booleanOp === "and"
                ? new q.MatchTermsAndExpr(termExpressions, scopeExpr)
                : new q.MatchTermsOrExpr(termExpressions, scopeExpr),
        ];
    }

    private async compileScope(
        searchGroup: SearchTermGroup,
        filter?: WhenFilter,
    ): Promise<q.GetScopeExpr | undefined> {
        let scopeSelectors: q.IQueryTextRangeSelector[] | undefined;
        // First, use any provided date ranges to select scope
        if (filter && filter.dateRange) {
            scopeSelectors ??= [];
            scopeSelectors.push(
                new q.TextRangesInDateRangeSelector(filter.dateRange),
            );
        }
        // Actions are inherently scope selecting. If any present in the query, use them
        // to restrict scope
        const actionTermsGroup =
            this.getActionTermsFromSearchGroup(searchGroup);
        if (actionTermsGroup) {
            scopeSelectors ??= [];
            const [searchTermsUsed, selectExpr] =
                this.compileSearchGroup(actionTermsGroup);
            scopeSelectors.push(
                new q.TextRangesWithTermMatchesSelector(selectExpr),
            );
            this.allScopeSearchTerms.push(...searchTermsUsed);
        }
        // If a thread index is available...
        const threads = this.secondaryIndexes?.threads;
        if (filter && filter.threadDescription && threads) {
            const threadsInScope = await threads.lookupThread(
                filter.threadDescription,
            );
            if (threadsInScope) {
                scopeSelectors ??= [];
                scopeSelectors.push(
                    new q.ThreadSelector(
                        threadsInScope.map(
                            (t) => threads.threads[t.threadOrdinal],
                        ),
                    ),
                );
            }
        }
        return scopeSelectors ? new q.GetScopeExpr(scopeSelectors) : undefined;
    }

    private compileWhere(filter: WhenFilter): q.IQuerySemanticRefPredicate[] {
        let predicates: q.IQuerySemanticRefPredicate[] = [];
        if (filter.knowledgeType) {
            predicates.push(new q.KnowledgeTypePredicate(filter.knowledgeType));
        }
        return predicates;
    }

    private async compileMessageReRank(
        srcExpr: IQueryOpExpr<MessageAccumulator>,
        rawQueryText?: string | undefined,
        maxMessageMatches?: number | undefined,
    ): Promise<IQueryOpExpr> {
        const messageIndex = this.conversation.secondaryIndexes?.messageIndex;
        if (
            messageIndex &&
            rawQueryText &&
            maxMessageMatches &&
            maxMessageMatches > 0 &&
            isMessageTextEmbeddingIndex(messageIndex)
        ) {
            // If embeddings supported, and there are too many matches, try to re-rank using similarity matching
            const embedding =
                await messageIndex.generateEmbedding(rawQueryText);
            return new q.RankMessagesBySimilarity(
                srcExpr,
                embedding,
                maxMessageMatches,
            );
        } else if (maxMessageMatches && maxMessageMatches > 0) {
            return new q.SelectTopNExpr(srcExpr, maxMessageMatches);
        } else {
            return new q.NoOpExpr(srcExpr);
        }
    }

    private getActionTermsFromSearchGroup(
        searchGroup: SearchTermGroup,
    ): SearchTermGroup | undefined {
        let actionGroup: SearchTermGroup | undefined;
        for (const term of searchGroup.terms) {
            if (isPropertyTerm(term) && isActionPropertyTerm(term)) {
                actionGroup ??= {
                    booleanOp: "and",
                    terms: [],
                };
                actionGroup.terms.push(term);
            }
        }
        return actionGroup;
    }

    private async resolveRelatedTerms(
        searchTerms: SearchTerm[],
        dedupe: boolean,
        filter?: WhenFilter,
    ) {
        this.validateAndPrepareSearchTerms(searchTerms);
        if (this.secondaryIndexes?.termToRelatedTermsIndex) {
            await resolveRelatedTerms(
                this.secondaryIndexes.termToRelatedTermsIndex,
                searchTerms,
                dedupe,
                //(term) => this.shouldFuzzyMatchRelatedTerms(term, filter),
            );
            // Ensure that the resolved terms are valid etc.
            this.validateAndPrepareSearchTerms(searchTerms);
        }
    }

    /*
    private shouldFuzzyMatchRelatedTerms(
        term: SearchTerm,
        filter?: WhenFilter,
    ): boolean {
        const kType = filter?.knowledgeType;
        if (kType && kType !== "entity") {
            return true;
        }
        // If the term exactly matches the name of an entity, don't do fuzzy resolution
        // The user was explicitly referring to an entity with a particular name
        return !isKnownProperty(
            this.secondaryIndexes?.propertyToSemanticRefIndex,
            PropertyNames.EntityName,
            term.term.text,
        );
    }
    */

    private validateAndPrepareSearchTerms(searchTerms: SearchTerm[]): void {
        for (const searchTerm of searchTerms) {
            this.validateAndPrepareSearchTerm(searchTerm);
        }
    }

    private validateAndPrepareSearchTerm(searchTerm: SearchTerm): boolean {
        if (!this.validateAndPrepareTerm(searchTerm.term)) {
            return false;
        }
        searchTerm.term.weight ??= this.defaultTermMatchWeight;
        if (searchTerm.relatedTerms) {
            for (const relatedTerm of searchTerm.relatedTerms) {
                if (!this.validateAndPrepareTerm(relatedTerm)) {
                    return false;
                }
                if (
                    relatedTerm.weight &&
                    relatedTerm.weight >= this.relatedIsExactThreshold
                ) {
                    relatedTerm.weight = this.defaultTermMatchWeight;
                }
            }
        }
        return true;
    }

    /**
     * Currently, just changes the case of a term
     *  But here, we may do other things like:
     * - Check for noise terms
     * - Do additional rewriting
     * - Additional checks that *reject* certain search terms
     * Return false if the term should be rejected
     */
    private validateAndPrepareTerm(term: Term | undefined): boolean {
        if (term) {
            term.text = term.text.toLowerCase();
        }
        return true;
    }

    private boostEntities(
        searchTerm: SearchTerm,
        sr: SemanticRef,
        scoredRef: ScoredSemanticRefOrdinal,
        boostWeight: number,
    ): ScoredSemanticRefOrdinal {
        if (
            sr.knowledgeType === "entity" &&
            q.matchEntityNameOrType(
                searchTerm,
                sr.knowledge as kpLib.ConcreteEntity,
            )
        ) {
            scoredRef = {
                semanticRefOrdinal: scoredRef.semanticRefOrdinal,
                score: scoredRef.score * boostWeight,
            };
        }
        return scoredRef;
    }
}

function isPropertyTerm(
    term: SearchTerm | PropertySearchTerm,
): term is PropertySearchTerm {
    return term.hasOwnProperty("propertyName");
}

function isEntityPropertyTerm(term: PropertySearchTerm): boolean {
    switch (term.propertyName) {
        default:
            break;
        case "name":
        case "type":
            return true;
    }
    return false;
}

function isActionPropertyTerm(term: PropertySearchTerm): boolean {
    switch (term.propertyName) {
        default:
            break;
        case "subject":
        case "verb":
        case "object":
        case "indirectObject":
            return true;
    }

    return false;
}
