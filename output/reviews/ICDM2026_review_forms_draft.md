# ICDM 2026 Review Forms - Submission-ready Draft

> Status: Questions 8-11 and 19 are rewritten from the existing notes. Questions 13-17 have been checked against the six supplied paper PDFs. These ratings reflect statements in the submissions and do not independently validate the linked repositories or datasets.
>
> Recommended score mapping used here: `borderline- -> -2`, `borderline+ / weak accept / accept -> 3`. Confidence is provisionally set to `1 (Medium)` because reviewer expertise cannot be inferred from the notes.

---

## DM1989 - Enhancing Adversarial Attacks via Parameter Adaptive Adversarial Attack

### Recommended selections

| Item | Selection |
|---|---|
| 1. Relevant to ICDM Research Track | Yes - Areas: 2, 3, 4 |
| 2. Innovation | 3 (Innovative) |
| 3. Technical quality | -2 (Marginal) |
| 4. Presentation | 3 (Good) |
| 5. Interest to the ICDM community | 2 (Maybe) |
| 6. Reviewer confidence | 1 (Medium) |
| 7. Overall recommendation | -2 (Marginal) |
| 12. Best 10% among reviewed submissions | No |
| 13. Datasets correctly identified/referenced | 3 (Yes) - ILSVRC 2012/ImageNet is identified and cited as [21]. |
| 14. Private-data availability statement | 0 (Not applicable) - only public ImageNet data are used. |
| 15. Competing methods correctly identified/referenced | 3 (Yes) - the evaluated attack baselines are named and cited. |
| 16. Source-code link or release statement | 3 (Yes) - an anonymous repository is provided and public release upon acceptance is stated. |
| 17. Experimental design reproducible | 3 (Yes) - sampling, seeds, attack settings, models, hardware, and protocol are described; exact sample indices are promised. |
| 18. Presentation format if accepted | Short Presentation |
| Confidential 2. Best paper award | No |
| Confidential 3. Journal special issue | No |
| Confidential 4. Serious ethics/policy concern | No, based on current notes; verify paper |
| Confidential 5. Generative AI used in preparing review | Yes |

### 8. Summary of the paper's main contribution and impact

This paper proposes Parameter-Adaptive Adversarial Attack (P3A), a wrapper that temporarily adapts surrogate-model parameters to obtain alternative input-gradient directions. It can be combined with several gradient-based attacks and reports improved black-box transfer success across CNNs, adversarially trained models, and vision transformers. The approach offers a useful perspective on transferable attacks, although its benefits are not yet separated from its additional computation.

### 9. Justification of the recommendation

The method is clear, modular, and empirically promising. However, P3A appears to use substantially more gradient evaluations than many baselines, without matched-compute or matched-runtime comparisons. This makes it unclear whether the gains come from parameter adaptation or additional computation. The local theoretical analysis, under-specified ASR protocol, relatively dated benchmark, and incomplete coverage of closely related baselines further limit the strength of the claims. I therefore consider the paper marginal.

### 10. Three strong points of this paper

1. The paper provides a clear and potentially useful reframing of transferable attacks by distinguishing directional supervision from directional optimization and by explicitly adapting surrogate parameters to improve input-gradient directions.
2. P3A is modular and can be combined with multiple established gradient-based attacks rather than being restricted to one optimization procedure.
3. The evaluation spans several attack families and model types, including CNNs, adversarially trained models, and vision transformers, and reports meaningful transfer-ASR improvements in multiple settings.

### 11. Three weak points of this paper

1. The comparison does not match gradient-evaluation or computation budgets. Because P3A evaluates multiple parameter perturbations at each step, it may use substantially more computation than the baselines.
2. The theoretical analysis relies on local first-order and finite-difference approximations and does not establish that the selected gradient improves multi-step projected attacks or black-box transferability.
3. The empirical protocol is incomplete for a strong state-of-the-art claim: it relies heavily on an older ImageNet transfer benchmark, does not fully specify clean-correct filtering for ASR, and omits important model-augmentation, weight-perturbation, ensemble, and feature-based baselines.

### 19. Detailed comments for the authors

The DSP/DOP framing is intuitive and the wrapper design is useful. The following issues are most important:

1. Report matched gradient-evaluation and runtime comparisons, including the exact forward/backward-pass cost of each method.
2. Clarify that the theory provides a local heuristic rather than a guarantee of multi-step transferability.
3. Specify the ASR denominator, clean-correct filtering, and clean accuracy for each source-target setting.
4. Add or justify the omission of weight-perturbation, surrogate-augmentation, ensemble, and other recent transfer baselines.

### Confidential comments

The paper has a promising idea and useful empirical results, but the unmatched computation budget is a central concern. My marginal recommendation could improve if the authors demonstrate that P3A remains superior under matched gradient/runtime budgets and clarify the ASR protocol. No separate ethics concern is apparent from the available notes.

---

## DM1477 - FinRED: An Expert-Guided Benchmark Generation and Evaluation Framework for Financial LLM Red-Teaming

### Recommended selections

| Item | Selection |
|---|---|
| 1. Relevant to ICDM Research Track | Yes - Areas: 7, 8 |
| 2. Innovation | 3 (Innovative) |
| 3. Technical quality | 3 (High) |
| 4. Presentation | 3 (Good) |
| 5. Interest to the ICDM community | 3 (Yes) |
| 6. Reviewer confidence | 1 (Medium) |
| 7. Overall recommendation | 3 (Should accept) |
| 12. Best 10% among reviewed submissions | No |
| 13. Datasets correctly identified/referenced | 3 (Yes) - FinRED and the external financial/safety benchmarks are clearly identified and cited. |
| 14. Private-data availability statement | 2 (Partial) - FinRED artifacts are available only through gated access for qualified researchers, not unrestricted public release. |
| 15. Competing methods correctly identified/referenced | 3 (Yes) - GCG, AutoDAN, TAP, GPTFuzzer, AutoDAN-Turbo, and the judge baseline are identified and cited. |
| 16. Source-code link or release statement | 3 (Yes) - GitHub and Hugging Face project links are provided. |
| 17. Experimental design reproducible | 3 (Yes) - attack budgets, hardware, prompt/rubric resources, dataset splits, and evaluation procedures are specified. |
| 18. Presentation format if accepted | Regular Presentation |
| Confidential 2. Best paper award | No |
| Confidential 3. Journal special issue | No |
| Confidential 4. Serious ethics/policy concern | No, assuming appropriate harmful-content governance; verify paper |
| Confidential 5. Generative AI used in preparing review | Yes |

### 8. Summary of the paper's main contribution and impact

This paper introduces FinRED, an expert-guided framework for red-teaming financial LLMs. It combines a finance-specific risk taxonomy, financial documents, structured prompt generation, and a domain-specific judging rubric developed with 12 financial experts. Experiments across multiple models and attack methods suggest that the proposed framework and judge provide a more domain-grounded evaluation of financial safety risks than generic safety benchmarks.

### 9. Justification of the recommendation

FinRED addresses an important and underexplored problem, with strong domain grounding and broad empirical validation. The main concerns are limited access to key artifacts, possible confirmation bias because the same experts participate in several stages, and insufficient analysis of benchmark difficulty and judge errors. These limitations affect reproducibility and generalization, but the benchmark remains a useful contribution. I therefore recommend acceptance.

### 10. Three strong points of this paper

1. The paper addresses an important gap in finance-specific LLM safety evaluation, where generic safety benchmarks may miss domain-specific regulatory and operational risks.
2. The benchmark is strongly grounded in expert knowledge, financial documents, structured schemas, and a domain-specific judging rubric.
3. The empirical evaluation spans multiple model families and attack methods and includes validation showing that the proposed judge aligns more closely with financial experts than a generic safety rubric.

### 11. Three weak points of this paper

1. Reproducibility is limited if the dataset, schemas, prompts, rubric, and generation pipeline remain gated or are available only through external links without sufficient in-paper documentation.
2. The same group of 12 experts appears to contribute to taxonomy design, schema refinement, prompt evaluation, and judge validation, which may introduce confirmation bias and limit independence.
3. Benchmark difficulty and judge reliability are not analyzed deeply enough: higher ASR may reflect prompt directness, while the judge study appears too small to characterize false positives, false negatives, and category-specific uncertainty.

### 19. Detailed comments for the authors

FinRED is well motivated and benefits from meaningful expert involvement. I suggest the following revisions:

1. Provide enough taxonomy, schema, rubric, prompt, and sampling details to make the benchmark auditable, even if some harmful content remains gated.
2. Clarify which experts participated in each stage and add independent validation or discuss the resulting confirmation bias.
3. Report agreement, false-positive and false-negative rates, and category-level judge performance.
4. Distinguish benchmark difficulty from prompt aggressiveness and discuss the framework's geographical and regulatory scope.

### Confidential comments

I recommend acceptance because the paper addresses a real gap and has unusually strong domain grounding. The main reservations are artifact accessibility and the lack of a clearly independent expert validation set. The chairs may wish to confirm that the release and privacy plan satisfies conference policy because the benchmark contains finance-specific adversarial content.

---

## DM1393 - SAGE: Safety-Aware Grounding with External-Knowledge Enhancement for Safety Alignment of Multimodal Large Language Models

### Recommended selections

| Item | Selection |
|---|---|
| 1. Relevant to ICDM Research Track | Yes - Areas: 3, 7 |
| 2. Innovation | -2 (Marginally) |
| 3. Technical quality | -2 (Marginal) |
| 4. Presentation | 3 (Good) |
| 5. Interest to the ICDM community | 2 (Maybe) |
| 6. Reviewer confidence | 1 (Medium) |
| 7. Overall recommendation | -2 (Marginal) |
| 12. Best 10% among reviewed submissions | No |
| 13. Datasets correctly identified/referenced | 3 (Yes) - all safety and utility benchmarks are identified and cited. |
| 14. Private-data availability statement | 0 (Not applicable) - the experiments use public benchmarks and a manually constructed knowledge base. |
| 15. Competing methods correctly identified/referenced | 3 (Yes) - ECSO and ETA are identified and cited; GuardAlign is also cited although not experimentally compared. |
| 16. Source-code link or release statement | 3 (Yes) - public release of the code and safety knowledge base upon acceptance is explicitly stated. |
| 17. Experimental design reproducible | 3 (Yes) - prompts, datasets, metrics, deterministic decoding, hardware, and knowledge-base contents are documented in the paper and appendix. |
| 18. Presentation format if accepted | Short Presentation |
| Confidential 2. Best paper award | No |
| Confidential 3. Journal special issue | No |
| Confidential 4. Serious ethics/policy concern | No, based on current notes; verify paper |
| Confidential 5. Generative AI used in preparing review | Yes |

### 8. Summary of the paper's main contribution and impact

This paper proposes SAGE, a training-free safety pipeline for multimodal LLMs. It converts multimodal inputs into a unified description, analyzes user intent, retrieves rules from a manually constructed safety knowledge base, and generates a safety-aware response. Experiments across several models and benchmarks report lower unsafe response rates while largely preserving general utility. The pipeline is interpretable, but the external knowledge component appears to provide only a limited incremental gain.

### 9. Justification of the recommendation

The paper addresses an important problem and presents a clear, interpretable pipeline with consistent safety improvements. However, ablations suggest that most gains come from description, rewriting, and intent analysis rather than the emphasized knowledge base. Reliance on a single judge, lack of over-refusal analysis, under-specified rule construction, and incomplete recent baselines further weaken the evidence. I therefore consider the paper marginal.

### 10. Three strong points of this paper

1. The paper addresses an important multimodal safety setting in which an image and a text prompt can become harmful only when interpreted jointly.
2. SAGE has a clear and interpretable test-time pipeline that exposes intermediate descriptions, intent labels, retrieved rules, and safety decisions.
3. The evaluation covers multiple MLLM backbones and safety benchmarks and reports substantial reductions in unsafe response rate while largely preserving performance on general multimodal benchmarks.

### 11. Three weak points of this paper

1. The ablation study suggests that the external knowledge base, which is the paper's emphasized contribution, provides only a small incremental benefit over description, rewriting, and intent analysis in important settings.
2. Safety evaluation relies predominantly on a single judge model without sufficient human validation, multi-judge agreement, or analysis of evaluator bias.
3. The paper lacks systematic over-refusal evaluation, provides insufficient detail about rule-base construction and benchmark overlap, and omits at least one closely related recent test-time safety baseline.

### 19. Detailed comments for the authors

SAGE is clear and interpretable, but the role of external knowledge needs stronger evidence.

1. Isolate the knowledge base through matched controls using generic or model-generated safety instructions.
2. Add human or multi-judge validation and report false-safe and false-unsafe cases.
3. Evaluate over-refusal on benign, borderline, and dual-use requests.
4. Document rule construction and benchmark overlap, and include or justify missing recent baselines.

### Confidential comments

The work is relevant and clearly presented, but the external-knowledge contribution is not yet convincingly isolated from a multi-stage prompting pipeline. My marginal recommendation is driven mainly by limited novelty attribution and evaluation reliability rather than by presentation quality.

---

## DM729 - K-GATE: Knowledge-Decomposed Graph-based Adversarial Trajectory Mining and Sequential Context Synthesis for Effective LLM Jailbreaking

### Recommended selections

| Item | Selection |
|---|---|
| 1. Relevant to ICDM Research Track | Yes - Areas: 4, 7 |
| 2. Innovation | 3 (Innovative) |
| 3. Technical quality | -2 (Marginal) |
| 4. Presentation | 3 (Good) |
| 5. Interest to the ICDM community | 3 (Yes) |
| 6. Reviewer confidence | 1 (Medium) |
| 7. Overall recommendation | 3 (Should accept) |
| 12. Best 10% among reviewed submissions | No |
| 13. Datasets correctly identified/referenced | 3 (Yes) - HarmBench and AdvBench are identified, described, and cited. |
| 14. Private-data availability statement | 0 (Not applicable) - the experiments use established public safety benchmarks. |
| 15. Competing methods correctly identified/referenced | 3 (Yes) - all eight single-turn, multi-turn, and search-based baselines are identified and cited. |
| 16. Source-code link or release statement | 3 (Yes) - an anonymous source-code and prompt repository is provided; sensitive templates will be shared with verified researchers. |
| 17. Experimental design reproducible | 2 (Partial) - major hyperparameters and hardware are given, but MCTS branch context/reset behavior and guardrail observation scope remain unclear. |
| 18. Presentation format if accepted | Regular Presentation |
| Confidential 2. Best paper award | No |
| Confidential 3. Journal special issue | No |
| Confidential 4. Serious ethics/policy concern | No, assuming appropriate jailbreak-research safeguards; verify paper |
| Confidential 5. Generative AI used in preparing review | Yes |

### 8. Summary of the paper's main contribution and impact

This paper proposes K-GATE, a multi-turn jailbreak framework that mines adversarial trajectories over a knowledge-decomposed graph using MCTS and sequential context synthesis. Experiments on HarmBench and AdvBench cover open and closed models, multiple baselines, ablations, and guardrails. The trajectory-level formulation is interesting, but it remains unclear whether the success comes from the target model's dialogue behavior or from harmful-goal information introduced by external decomposition and aggregation modules.

### 9. Justification of the recommendation

K-GATE presents an interesting formulation and a relatively broad evaluation. However, external aggregation, goal-conditioned judging, and knowledge decomposition may inject much of the harmful intent, making the causal interpretation uncertain. Conversation-state handling and guardrail visibility are also under-specified. I lean toward acceptance because the framework and results are useful, but the claims should be narrowed or supported with controls that isolate the target model's contribution.

### 10. Three strong points of this paper

1. The paper introduces an interesting formulation of multi-turn jailbreaking as trajectory mining over a knowledge-decomposed graph rather than isolated prompt optimization.
2. The three-stage framework - graph construction, MCTS-based trajectory mining, and sequential context synthesis - is structured and easy to follow.
3. The empirical evaluation is relatively broad, covering HarmBench and AdvBench, open and closed models, several attack families, ablations, and guardrail analysis.

### 11. Three weak points of this paper

1. The final success may be driven by the external aggregation module, which appears to have access to the original harmful goal, rather than by harmful intent accumulated naturally within the target model's dialogue state.
2. Goal-conditioned evaluation can label benign local information as harmful because it is useful to a known adversarial plan, conflating intrinsic harmfulness with attacker utility.
3. Essential implementation and control details are missing, including the contribution of attacker prior knowledge in DAG construction, MCTS context/reset behavior, the guardrails' observation scope, and component-wise harmfulness measurements.

### 19. Detailed comments for the authors

The trajectory-level perspective is useful, but the source of attack success should be isolated.

1. Test aggregation without access to the original harmful goal and compare against DAG plus aggregation without target-model responses.
2. Report judging both with and without the original goal, separating local response harmfulness from adversarial utility.
3. Clarify MCTS conversation-state handling and exactly what dialogue context each guardrail observes.
4. Report query cost and matched-budget comparisons, and narrow the causal claim if external orchestration is essential.

### Confidential comments

I lean toward acceptance because the trajectory-mining formulation is interesting and the evaluation is broad. However, the causal interpretation is currently too strong: external goal knowledge, aggregation, and judging may account for a substantial fraction of the reported success. The work also requires careful responsible-release handling, although no policy violation is apparent from the notes alone.

---

## DM1389 - SKAG: Improving Safety of VLMs with Safety Knowledge Augmented Generation

### Recommended selections

| Item | Selection |
|---|---|
| 1. Relevant to ICDM Research Track | Yes - Areas: 3, 7 |
| 2. Innovation | -2 (Marginally) |
| 3. Technical quality | -2 (Marginal) |
| 4. Presentation | 3 (Good) |
| 5. Interest to the ICDM community | 2 (Maybe) |
| 6. Reviewer confidence | 1 (Medium) |
| 7. Overall recommendation | -2 (Marginal) |
| 12. Best 10% among reviewed submissions | No |
| 13. Datasets correctly identified/referenced | 3 (Yes) - SIUO, MSSBench, MM-SafetyBench, SPA-VL, and the utility benchmarks are identified and cited. |
| 14. Private-data availability statement | 0 (Not applicable) - the experiments use public datasets and derived knowledge bases. |
| 15. Competing methods correctly identified/referenced | 3 (Yes) - ECSO and ETA are cited and their reproduction is described; GuardAlign is cited with an explanation for exclusion. |
| 16. Source-code link or release statement | 3 (Yes) - the paper states that all code, artifacts, and generated results will be publicly released on GitHub. |
| 17. Experimental design reproducible | 3 (Yes) - retrieval parameters, decoding settings, prompts, dataset splits, hardware/software setup, and baseline reproduction details are provided. |
| 18. Presentation format if accepted | Short Presentation |
| Confidential 2. Best paper award | No |
| Confidential 3. Journal special issue | No |
| Confidential 4. Serious ethics/policy concern | No, based on current notes; verify paper |
| Confidential 5. Generative AI used in preparing review | Yes |

### 8. Summary of the paper's main contribution and impact

This paper proposes SKAG, a training-free pipeline that reframes multimodal inputs, retrieves safety knowledge, and uses it to guide VLM responses. Experiments across four safety benchmarks and several model families report improved safe response rates, with ablations suggesting that retrieval helps on implicit cross-modal risks. The method is practical and interpretable, but its novelty is limited and constructing the knowledge base from safety datasets creates a risk of benchmark-specific leakage.

### 9. Justification of the recommendation

SKAG is simple, interpretable, and evaluated across several models and datasets. However, its knowledge base is derived from safety datasets and related materials, so the gains may reflect benchmark overlap rather than generalization. Reliance on a single judge, missing over-refusal analysis, incomplete utility evaluation, and limited methodological novelty further weaken the contribution. I therefore consider the paper marginal.

### 10. Three strong points of this paper

1. The paper studies an important cross-modal safety problem in which image and text can jointly imply a risk that is not evident from either modality alone.
2. SKAG is simple, training-free, interpretable, and potentially easy to deploy across multiple VLM backbones.
3. The evaluation covers four safety benchmarks and several model families, and the ablations indicate that retrieved knowledge can improve safety on implicit cross-modal cases.

### 11. Three weak points of this paper

1. Constructing the safety knowledge base from benchmark datasets, metadata, hints, warnings, and reference answers creates a substantial risk of benchmark-specific leakage and overfitting.
2. The safety results rely heavily on a single LLM judge without adequate human evaluation, multi-judge validation, or agreement analysis.
3. The paper lacks systematic over-refusal analysis, and its utility evaluation is incomplete because general-capability results are not reported for all model families used in the safety experiments.

### 19. Detailed comments for the authors

SKAG is practical, but the paper needs stronger evidence of cross-benchmark generalization.

1. Audit knowledge-test overlap and add leave-one-benchmark-out or fully held-out evaluation.
2. Compare retrieval against generic, random, and model-generated safety guidance controls.
3. Add human or multi-judge validation and evaluate over-refusal on benign and dual-use requests.
4. Complete utility evaluation across all model families and clarify the method's novelty relative to related pipelines.

### Confidential comments

My marginal recommendation is driven by the possibility of benchmark-specific knowledge leakage and limited novelty. A strict leave-one-dataset-out evaluation and independent judge validation could materially change the assessment.

---

## DM1127 - AICompanionBench: Benchmarking LLMs-as-Judges for AI Companion Safety

### Recommended selections

| Item | Selection |
|---|---|
| 1. Relevant to ICDM Research Track | Yes - Areas: 3, 7, 8 |
| 2. Innovation | 3 (Innovative) |
| 3. Technical quality | -2 (Marginal) |
| 4. Presentation | 3 (Good) |
| 5. Interest to the ICDM community | 3 (Yes) |
| 6. Reviewer confidence | 1 (Medium) |
| 7. Overall recommendation | 3 (Should accept) |
| 12. Best 10% among reviewed submissions | No |
| 13. Datasets correctly identified/referenced | 3 (Yes) - AICompanionBench's Reddit/Replika source, collection period, size, and public dataset link are provided. |
| 14. Private-data availability statement | 0 (Not applicable) - the study collects publicly posted Reddit screenshots rather than private experimental data. |
| 15. Competing methods correctly identified/referenced | 2 (Partial) - the 20 evaluated models are named, but exact model/API versions and citations are incomplete. |
| 16. Source-code link or release statement | 1 (No) - a dataset repository is provided, but the paper does not provide or promise release of the collection, OCR, filtering, and evaluation code. |
| 17. Experimental design reproducible | 2 (Partial) - the pipeline and full annotation prompt are described, but model/API settings, OCR quality control, and some sampling details are insufficient for exact reproduction. |
| 18. Presentation format if accepted | Regular Presentation |
| Confidential 2. Best paper award | No |
| Confidential 3. Journal special issue | No |
| Confidential 4. Serious ethics/policy concern | **VERIFY privacy, consent, and redistribution of Reddit screenshots before selecting No** |
| Confidential 5. Generative AI used in preparing review | Yes |

### 8. Summary of the paper's main contribution and impact

This paper introduces AICompanionBench, a benchmark for evaluating LLM judges on AI-companion safety. It contains 2,123 Replika conversations collected from Reddit screenshots and labeled into eight unsafe categories plus a safe category. Evaluation of 20 open and closed models shows that explicit harms are easier to detect than implicit or contextual risks such as manipulation. The benchmark addresses an important and underexplored safety setting.

### 9. Justification of the recommendation

The benchmark is timely, fine-grained, and supported by a broad evaluation of 20 LLM judges. However, LLM-based pre-filtering may exclude subtle cases, while reliance on one main annotator and model-informed label revision weakens label independence. Class imbalance and data from self-selected Reddit posts about one platform also limit generalization. Despite these concerns, the benchmark is a useful contribution, so I recommend weak acceptance.

### 10. Three strong points of this paper

1. The paper addresses the important and socially consequential problem of evaluating safety in emotionally engaging AI-companion conversations.
2. AICompanionBench provides real-world conversations with fine-grained labels covering eight unsafe categories plus a safe category, rather than only binary harmfulness labels.
3. The evaluation covers 20 open and closed LLM judges and reveals useful category-specific weaknesses, especially for implicit, contextual, and safe interactions.

### 11. Three weak points of this paper

1. The LLM-based pre-filtering funnel may bias the benchmark toward unsafe cases that current models can already detect and may exclude subtle failures that all filtering models miss.
2. Ground-truth reliability is not sufficiently established because final labels rely mainly on one annotator and label revision appears to use model predictions; the reported machine-human kappa does not replace independent inter-annotator agreement.
3. The category distribution is highly imbalanced, and data from self-selected Reddit screenshots of one companion platform may not generalize to ordinary usage or other platforms.

### 19. Detailed comments for the authors

The real-world setting and fine-grained labels are valuable, but dataset reliability needs stronger support.

1. Estimate filtering bias by manually checking samples rejected at each LLM-filtering stage.
2. Add independent annotators, category-level agreement, and an adjudication procedure without exposing initial labels to model predictions.
3. Report macro metrics and uncertainty under class imbalance, and narrow generalization claims unless cross-platform data are added.
4. Clarify OCR quality, privacy protection, consent or redistribution rights, and handling of identifying information.

### Confidential comments

I recommend weak acceptance because the benchmark addresses a meaningful gap and the multi-model evaluation is informative. The chairs should verify the paper's privacy, consent, and redistribution procedures for Reddit screenshots and sensitive companion conversations. Label independence and selection bias are the main technical reservations.

---

## Final checks before submission

1. Optionally open the linked anonymous repositories to confirm that they remain accessible; the ratings above are based on the links and release statements printed in the PDFs.
2. Reconcile the recommended overall scores with the reviewer's intended calibration; the form has no weak-accept or weak-reject option between `-2` and `3`.
3. Select `Yes` for generative-AI assistance if this revised text is used in the submitted review, subject to the conference's review-confidentiality and AI-use policy.
